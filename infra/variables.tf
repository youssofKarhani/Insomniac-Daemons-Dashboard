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
  default     = ["http://localhost:5173", "http://localhost:4173"]
}

variable "gpu_instance_type" {
  type    = string
  default = "g5.xlarge"
}

variable "gpu_az" {
  type    = string
  default = "eu-north-1c"
}
