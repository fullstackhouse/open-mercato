variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region for Cloud SQL"
}

variable "registry_region" {
  type        = string
  description = "GCP region for Artifact Registry (defaults to region)"
  default     = null
}

variable "environment" {
  type        = string
  description = "Environment name (dev or prod)"
}

variable "service_name_prefix" {
  type        = string
  description = "Prefix for services and secrets (e.g., om-dev)"
}

variable "github_org" {
  type        = string
  description = "GitHub organization name"
  default     = "open-mercato"
}

variable "github_repo" {
  type        = string
  description = "GitHub repository name"
  default     = "open-mercato"
}

variable "github_extra_repos" {
  type        = list(string)
  description = "Additional GitHub repos (org/repo format) allowed to authenticate via OIDC"
  default     = []
}

variable "vpc_network" {
  type        = string
  default     = "default"
  description = "VPC network name"
}

variable "enable_private_ip" {
  type        = bool
  default     = false
  description = "Enable private IP for Cloud SQL"
}

variable "database_url" {
  type        = string
  sensitive   = true
  default     = null
  description = "Override database URL (if not using auto-generated)"
}

variable "db_tier" {
  type        = string
  default     = "db-f1-micro"
  description = "Cloud SQL instance machine tier"
}
