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

output "ingest_function" {
  value = aws_lambda_function.ingest.function_name
}

# A write endpoint: never put it in the site, the public data or the repository.
output "ingest_url" {
  value     = var.enable_ingest ? aws_lambda_function_url.ingest[0].function_url : null
  sensitive = true
}

output "ingest_secret_params" {
  value = [aws_ssm_parameter.ingest_hmac.name, aws_ssm_parameter.job_salt.name]
}
