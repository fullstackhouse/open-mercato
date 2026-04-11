variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region for Cloud Run"
  default     = "europe-west1"
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
  description = "Prefix for Cloud Run services (e.g., om-dev)"
}

variable "cloud_sql_connection_name" {
  type        = string
  description = "Connection name of the Cloud SQL instance"
}

variable "app_env" {
  type        = string
  description = "APP_ENV value for the application"
}

variable "app_url" {
  type        = string
  description = "Public URL of the application"
  default     = ""
}

variable "enable_domain_mapping" {
  type        = bool
  default     = false
  description = "Whether to create Cloud Run domain mapping"
}

variable "domain" {
  type        = string
  default     = ""
  description = "Custom domain for the application"
}

variable "min_instances" {
  type        = number
  default     = 0
  description = "Minimum number of Cloud Run instances"
}

variable "max_instances" {
  type        = number
  default     = 5
  description = "Maximum number of Cloud Run instances"
}

variable "memory" {
  type        = string
  default     = "2Gi"
  description = "Memory allocation for Cloud Run instances"
}

variable "cpu" {
  type        = string
  default     = "1"
  description = "CPU allocation for Cloud Run instances"
}

# Secret IDs from infrastructure module
variable "database_secret_id" {
  type        = string
  description = "Secret ID for DATABASE_URL"
}

variable "jwt_secret_id" {
  type        = string
  description = "Secret ID for JWT_SECRET"
}

variable "auth_secret_id" {
  type        = string
  description = "Secret ID for AUTH_SECRET"
}

variable "encryption_key_secret_id" {
  type        = string
  description = "Secret ID for TENANT_DATA_ENCRYPTION_KEY"
}
