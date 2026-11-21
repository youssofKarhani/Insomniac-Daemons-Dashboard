# ==============================================================================
# Insomniac Daemons Dashboard: telemetry stack
#
# Read-only observer of the platform. It creates its own resources only and
# never modifies any platform resource. Platform resources are found by name.
# ==============================================================================

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.80" }
    archive = { source = "hashicorp/archive", version = "~> 2.6" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.project, ManagedBy = "terraform", Repo = "AWS-dashboard" }
  }
}

locals {
  name = var.project
  queue_names = {
    workflow    = "${var.platform_prefix}-ai-jobs"
    gpu         = "${var.platform_prefix}-gpu-inference-jobs"
    workflowDlq = "${var.platform_prefix}-ai-jobs-dlq"
    gpuDlq      = "${var.platform_prefix}-gpu-inference-jobs-dlq"
  }
  gpu_asg_prefix = "${var.platform_prefix}-gpu-asg-"
}

# ---- platform resources, looked up (never managed) ---------------------------

data "aws_instance" "control_plane" {
  filter {
    name   = "tag:Name"
    values = ["${var.platform_prefix}-k3s-control-plane"]
  }
  filter {
    name   = "instance-state-name"
    values = ["pending", "running", "stopping", "stopped"]
  }
}

data "aws_sqs_queue" "q" {
  for_each = local.queue_names
  name     = each.value
}

# ---- storage --------------------------------------------------------------------

resource "aws_dynamodb_table" "twin" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
}

resource "aws_s3_bucket" "data" {
  bucket_prefix = "${local.name}-data-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# ---- CDN: the only public surface (GET/HEAD of JSON files) ----------------------

resource "aws_cloudfront_origin_access_control" "data" {
  name                              = "${local.name}-data"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CachingOptimized keeps Host out of the cache key (S3 needs its own Host) and still
# honours each object's Cache-Control max-age (min TTL is 1 s), e.g. 5 s on live.json.
data "aws_cloudfront_cache_policy" "origin_headers" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_response_headers_policy" "cors" {
  name = "${local.name}-cors"
  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD"] }
    access_control_allow_origins { items = var.allowed_origins }
    access_control_max_age_sec = 600
    origin_override            = true
  }
  security_headers_config {
    content_type_options { override = true }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

resource "aws_cloudfront_distribution" "data" {
  enabled         = true
  comment         = "Sleepless Twin public telemetry (read-only JSON)"
  price_class     = "PriceClass_100"
  is_ipv6_enabled = true

  origin {
    origin_id                = "data"
    domain_name              = aws_s3_bucket.data.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.data.id
  }

  default_cache_behavior {
    target_origin_id           = "data"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.origin_headers.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.cors.id
    compress                   = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "data_bucket" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.data.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.data.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "data" {
  bucket     = aws_s3_bucket.data.id
  policy     = data.aws_iam_policy_document.data_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.data]
}

# ---- code ---------------------------------------------------------------------------

data "archive_file" "telemetry" {
  type        = "zip"
  source_dir  = "${path.module}/../telemetry"
  output_path = "${path.module}/.build/telemetry.zip"
  excludes    = [".venv/**", "tests/**", ".pytest_cache/**", "**/__pycache__/**", "pyproject.toml", "uv.lock"]
}

locals {
  lambda_env = {
    TABLE_NAME        = aws_dynamodb_table.twin.name
    DATA_BUCKET       = aws_s3_bucket.data.id
    CP_INSTANCE_ID    = data.aws_instance.control_plane.id
    GPU_ASG_PREFIX    = local.gpu_asg_prefix
    QUEUE_URLS        = jsonencode({ for k, q in data.aws_sqs_queue.q : k => q.url })
    GPU_INSTANCE_TYPE = var.gpu_instance_type
    GPU_AZ            = var.gpu_az
    MODEL_VOLUME_NAME = var.model_volume_name
  }
}
