module "infrastructure" {
  source = "../_common/modules/infrastructure"

  project_id          = var.project_id
  region              = var.region
  environment         = "dev"
  service_name_prefix = "om-dev"
  github_org          = var.github_org
  github_repo         = var.github_repo
  github_extra_repos  = ["fullstackhouse/open-mercato"]
}

module "mercato" {
  source = "../_common/modules/mercato"

  project_id                = var.project_id
  region                    = var.region
  environment               = "dev"
  service_name_prefix       = "om-dev"
  cloud_sql_connection_name = module.infrastructure.cloud_sql_connection_name
  app_env                   = "dev"
  app_url                   = ""
  min_instances             = 0
  max_instances             = 5
  memory                    = "2Gi"
  cpu                       = "1"

  database_secret_id       = module.infrastructure.database_url_secret_id
  jwt_secret_id            = module.infrastructure.jwt_secret_secret_id
  auth_secret_id           = module.infrastructure.auth_secret_secret_id
  encryption_key_secret_id = module.infrastructure.encryption_key_secret_id

  depends_on = [module.infrastructure]
}

output "service_url" {
  value = module.mercato.service_url
}

output "service_name" {
  value = module.mercato.service_name
}

output "migrations_job_name" {
  value = module.mercato.migrations_job_name
}

output "artifact_registry_url" {
  value = module.infrastructure.artifact_registry_url
}

output "cloud_sql_connection_name" {
  value = module.infrastructure.cloud_sql_connection_name
}

output "workload_identity_provider" {
  value = module.infrastructure.workload_identity_provider
}

output "service_account_email" {
  value = module.infrastructure.service_account_email
}
