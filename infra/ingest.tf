# ---- Phase D step 2: ingest Lambda --------------------------------------------------
#
# The only way application-level events (exporter batches, wake Lambda log lines)
# enter the twin. It authenticates, reduces to allowlisted events with pseudonymous
# job ids, and async-invokes the telemetry Lambda, which stays the single writer.
# Inert until a source sends: nothing calls it yet.

# Secrets live in SSM, not in Terraform state: created with a placeholder, then set
# once out of band (see README). The function refuses all input until both are set.
resource "aws_ssm_parameter" "ingest_hmac" {
  name        = "/${local.name}/ingest-hmac"
  description = "HMAC key the in-cluster exporter signs batches with."
  type        = "SecureString"
  value       = "unset"
  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "job_salt" {
  name        = "/${local.name}/job-salt"
  description = "Salt for pseudonymous job ids. Separate from the HMAC key so rotating that keeps ids stable."
  type        = "SecureString"
  value       = "unset"
  lifecycle { ignore_changes = [value] }
}

resource "aws_iam_role" "ingest" {
  name               = "${local.name}-ingest"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "ingest" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ingest.arn}:*"]
  }
  statement {
    sid       = "ReadSecrets"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.ingest_hmac.arn, aws_ssm_parameter.job_salt.arn]
  }
  statement {
    sid       = "HandOff"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.telemetry.arn]
  }
}

resource "aws_iam_role_policy" "ingest" {
  role   = aws_iam_role.ingest.id
  policy = data.aws_iam_policy_document.ingest.json
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${local.name}-ingest"
  retention_in_days = 14
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${local.name}-ingest"
  role             = aws_iam_role.ingest.arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "twin.ingest.lambda_handler"
  filename         = data.archive_file.telemetry.output_path
  source_code_hash = data.archive_file.telemetry.output_base64sha256
  timeout          = 10
  memory_size      = 128
  # Caps cost and blast radius of unauthenticated traffic to the URL.
  reserved_concurrent_executions = 2
  environment {
    variables = {
      INGEST_HMAC_PARAM  = aws_ssm_parameter.ingest_hmac.name
      JOB_SALT_PARAM     = aws_ssm_parameter.job_salt.name
      TELEMETRY_FUNCTION = aws_lambda_function.telemetry.function_name
    }
  }
  depends_on = [aws_cloudwatch_log_group.ingest]
}

# Public URL, authenticated inside the function by HMAC. Only lambda:InvokeFunctionUrl
# is granted to everyone; never plain lambda:InvokeFunction, which would let any AWS
# principal invoke directly with a forged log batch and skip the signature check.
resource "aws_lambda_function_url" "ingest" {
  count              = var.enable_ingest ? 1 : 0
  function_name      = aws_lambda_function.ingest.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "ingest_url" {
  count                  = var.enable_ingest ? 1 : 0
  statement_id           = "function-url-public"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.ingest.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Public function URLs also need lambda:InvokeFunction, limited by the condition
# lambda:InvokedViaFunctionUrl = true so it cannot be used for direct invokes. The
# AWS provider (5.x) cannot set that condition, so the AWS CLI manages this one
# statement. Needs the AWS CLI and credentials in the environment that runs Terraform.
resource "terraform_data" "ingest_url_invoke" {
  count            = var.enable_ingest ? 1 : 0
  triggers_replace = [aws_lambda_function.ingest.function_name, aws_lambda_function_url.ingest[0].function_url]
  input            = aws_lambda_function.ingest.function_name

  provisioner "local-exec" {
    interpreter = ["powershell", "-NoProfile", "-Command"]
    command     = "aws lambda remove-permission --function-name ${self.input} --statement-id function-url-invoke 2>$null; aws lambda add-permission --function-name ${self.input} --statement-id function-url-invoke --action lambda:InvokeFunction --principal '*' --invoked-via-function-url --output text --query Sid; if ($LASTEXITCODE -ne 0) { exit 1 }"
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["powershell", "-NoProfile", "-Command"]
    command     = "aws lambda remove-permission --function-name ${self.input} --statement-id function-url-invoke 2>$null; exit 0"
  }
}
