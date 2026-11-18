output "data_base_url" {
  description = "Set this as VITE_TWIN_DATA_URL when building the site."
  value       = "https://${aws_cloudfront_distribution.data.domain_name}"
}

output "data_bucket" {
  value = aws_s3_bucket.data.id
}

output "telemetry_function" {
  value = aws_lambda_function.telemetry.function_name
}

output "costs_function" {
  value = aws_lambda_function.costs.function_name
}
