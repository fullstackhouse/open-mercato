output "artifact_registry_url" {
  description = "Docker registry hostname for pushing/pulling images"
  value       = "${local.registry_region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.open_mercato.repository_id}"
}

output "cloud_sql_instance_name" {
  description = "Cloud SQL instance name"
  value       = google_sql_database_instance.main.name
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name used by Cloud SQL Auth Proxy / Cloud Run"
  value       = google_sql_database_instance.main.connection_name
}

output "workload_identity_provider" {
  description = "Full resource name of the Workload Identity Pool Provider for GitHub Actions OIDC"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "service_account_email" {
  description = "Email of the GitHub Actions service account"
  value       = google_service_account.github_actions.email
}

# Secret IDs (not versions) — callers use these to reference secrets in Cloud Run

output "database_url_secret_id" {
  description = "Secret Manager secret ID for the app database URL"
  value       = google_secret_manager_secret.database_url.secret_id
}

output "jwt_secret_secret_id" {
  description = "Secret Manager secret ID for JWT_SECRET"
  value       = google_secret_manager_secret.jwt_secret.secret_id
}

output "auth_secret_secret_id" {
  description = "Secret Manager secret ID for AUTH_SECRET"
  value       = google_secret_manager_secret.auth_secret.secret_id
}

output "encryption_key_secret_id" {
  description = "Secret Manager secret ID for ENCRYPTION_KEY"
  value       = google_secret_manager_secret.encryption_key.secret_id
}

output "database_admin_secret_id" {
  description = "Secret Manager secret ID for the admin database URL (dev only)"
  value       = local.is_dev ? google_secret_manager_secret.database_admin_url[0].secret_id : null
}

# Convenience list consumed by Cloud Run service `depends_on` or startup probes.
output "api_service_dependencies" {
  description = "List of GCP API service names enabled by this module"
  value       = [for svc in google_project_service.apis : svc.service]
}
