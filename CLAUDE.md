# AWS Dashboard (Infrastructure Twin)

This folder holds the interactive digital twin of the "My Sleepless Slaves" AWS platform.

## Hard rule: the platform repo is read-only

`C:\Users\USER\Desktop\My_Projects\My sleepless slaves` is reference material only.

- Never edit, create, move or delete anything in it, by any tool (Edit, Write, shell commands, git, formatters, `uv`, `terraform`, `kubectl apply` from it).
- Never run its scripts (`deploy.sh`, `aws_sync_and_deploy.py`, `destroy-dev.sh`, …). Several of them change live AWS resources.
- Never read `.env`, `terraform.tfstate*` or `terraform.tfvars` there; they hold secrets and live identifiers.
- Anything the twin needs from the platform (types, event names, config values) is copied into this repo and kept here.
- Any change the twin needs on the live platform (an exporter pod, a log subscription, an API change) is proposed to the owner first and lives in this repo's own infrastructure code, never in the platform repo.

## Public-safety rule

The public site must never contain: AWS account ID, instance/volume/subnet/VPC/ASG IDs, the wake API URL, job payloads or outputs, IAM ARNs, or any write/control endpoint.
