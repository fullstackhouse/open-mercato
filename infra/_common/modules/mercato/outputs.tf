output "service_url" {
  value       = google_cloud_run_v2_service.app.uri
  description = "URL of the Cloud Run service"
}

output "service_name" {
  value       = google_cloud_run_v2_service.app.name
  description = "Name of the Cloud Run service"
}

output "migrations_job_name" {
  value       = google_cloud_run_v2_job.migrations.name
  description = "Name of the migrations Cloud Run job"
}
