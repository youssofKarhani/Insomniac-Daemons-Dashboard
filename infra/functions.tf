# ---- IAM: read-only on the platform, write-only to the twin's own storage ----------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "telemetry" {
  name               = "${local.name}-telemetry"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "costs" {
  name               = "${local.name}-costs"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "telemetry" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.telemetry.arn}:*"]
  }
  statement {
    sid       = "TwinTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.twin.arn]
  }
  statement {
    sid       = "PublishJson"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/live.json", "${aws_s3_bucket.data.arn}/runs/*"]
  }
  statement {
    sid       = "ReadQueueDepth"
    actions   = ["sqs:GetQueueAttributes"]
    resources = [for q in data.aws_sqs_queue.q : q.arn]
  }
  statement {
    sid       = "DescribeOnly"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeVolumes", "autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"] # these Describe calls do not support resource-level permissions
  }
}

data "aws_iam_policy_document" "costs" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.costs.arn}:*"]
  }
  statement {
    sid       = "PublishCosts"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/costs.json"]
  }
  statement {
    sid       = "ReadCostsAndPrices"
    actions   = ["ce:GetCostAndUsage", "pricing:GetProducts", "ec2:DescribeSpotPriceHistory", "ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "telemetry" {
  role   = aws_iam_role.telemetry.id
  policy = data.aws_iam_policy_document.telemetry.json
}

resource "aws_iam_role_policy" "costs" {
  role   = aws_iam_role.costs.id
  policy = data.aws_iam_policy_document.costs.json
}

# ---- functions ------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "telemetry" {
  name              = "/aws/lambda/${local.name}-telemetry"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "costs" {
  name              = "/aws/lambda/${local.name}-costs"
  retention_in_days = 14
}

resource "aws_lambda_function" "telemetry" {
  function_name    = "${local.name}-telemetry"
  role             = aws_iam_role.telemetry.arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "twin.handlers.telemetry_handler"
  filename         = data.archive_file.telemetry.output_path
  source_code_hash = data.archive_file.telemetry.output_base64sha256
  timeout          = 30
  memory_size      = 256
  # One at a time, so bookkeeping in the table never races. Throttled async
  # invocations are retried by Lambda, so no event is lost.
  reserved_concurrent_executions = 1
  environment { variables = local.lambda_env }
  depends_on = [aws_cloudwatch_log_group.telemetry]
}

resource "aws_lambda_function_event_invoke_config" "telemetry" {
  function_name                = aws_lambda_function.telemetry.function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3600
}

resource "aws_lambda_function" "costs" {
  function_name    = "${local.name}-costs"
  role             = aws_iam_role.costs.arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "twin.handlers.costs_handler"
  filename         = data.archive_file.telemetry.output_path
  source_code_hash = data.archive_file.telemetry.output_base64sha256
  timeout          = 60
  memory_size      = 256
  environment { variables = local.lambda_env }
  depends_on = [aws_cloudwatch_log_group.costs]
}

# ---- triggers (new rules owned by the twin; platform rules are untouched) ---------

resource "aws_cloudwatch_event_rule" "ec2_state" {
  name        = "${local.name}-ec2-state"
  description = "EC2 state changes; the function keeps only the control plane and GPU instances."
  event_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EC2 Instance State-change Notification", "EC2 Spot Instance Interruption Warning"]
  })
}

resource "aws_cloudwatch_event_rule" "asg" {
  name        = "${local.name}-gpu-asg"
  description = "GPU Auto Scaling group launch failures."
  event_pattern = jsonencode({
    source        = ["aws.autoscaling"]
    "detail-type" = ["EC2 Instance Launch Unsuccessful"]
    detail        = { AutoScalingGroupName = [{ prefix = local.gpu_asg_prefix }] }
  })
}

resource "aws_cloudwatch_event_rule" "poll" {
  name                = "${local.name}-poll"
  description         = "Queue depth, GPU group capacity and launch lock, once a minute."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_rule" "costs" {
  name                = "${local.name}-costs"
  description         = "Daily billed costs and list prices."
  schedule_expression = "cron(15 6 * * ? *)"
}

locals {
  telemetry_rules = {
    ec2_state = aws_cloudwatch_event_rule.ec2_state
    asg       = aws_cloudwatch_event_rule.asg
    poll      = aws_cloudwatch_event_rule.poll
  }
}

resource "aws_cloudwatch_event_target" "telemetry" {
  for_each = local.telemetry_rules
  rule     = each.value.name
  arn      = aws_lambda_function.telemetry.arn
  input    = each.key == "poll" ? jsonencode({ twin = "poll" }) : null
}

resource "aws_lambda_permission" "telemetry" {
  for_each      = local.telemetry_rules
  statement_id  = "events-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.telemetry.function_name
  principal     = "events.amazonaws.com"
  source_arn    = each.value.arn
}

resource "aws_cloudwatch_event_target" "costs" {
  rule = aws_cloudwatch_event_rule.costs.name
  arn  = aws_lambda_function.costs.arn
}

resource "aws_lambda_permission" "costs" {
  statement_id  = "events-costs"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.costs.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.costs.arn
}
