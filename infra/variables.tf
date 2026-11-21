variable "region" {
  type    = string
  default = "eu-north-1"
}

variable "project" {
  description = "Name prefix for every resource this stack creates."
  type        = string
  default     = "sleepless-twin"
}

variable "platform_prefix" {
  description = "Prefix the platform uses for its resource names (looked up, never modified)."
  type        = string
  default     = "personal-ai"
}

variable "allowed_origins" {
  description = "Origins allowed to fetch the public JSON (the site, plus local dev)."
  type        = list(string)
  default     = ["https://insomniac-daemons-dashboard-production.up.railway.app", "http://localhost:5173", "http://localhost:4173"]
}

variable "gpu_instance_type" {
  type    = string
  default = "g5.xlarge"
}

variable "gpu_az" {
  type    = string
  default = "eu-north-1c"
}

variable "enable_ingest" {
  description = "Expose the ingest Lambda through a function URL (Phase D). false removes the URL; the function stays."
  type        = bool
  default     = true
}

variable "enable_wake_log_subscription" {
  description = "Subscribe the ingest Lambda to fixed phrases in the wake Lambda's logs (Phase D step 3, approved 2026-11-18). false removes the filter."
  type        = bool
  default     = true
}

variable "wake_log_group" {
  description = "Log group of the platform's wake Lambda."
  type        = string
  default     = "/aws/lambda/personal-ai-wake-ingress"
}

variable "model_volume_name" {
  description = "Name tag of the platform's model-cache EBS volume (read-only lookup for attachment state)."
  type        = string
  default     = "personal-ai-model-cache-ebs-1c"
}
