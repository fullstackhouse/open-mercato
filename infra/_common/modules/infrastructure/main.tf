# Infrastructure module: GCP APIs, Cloud SQL, Artifact Registry, Secrets Manager,
# GitHub Actions OIDC. Consumed by per-environment root modules.

terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  registry_region  = coalesce(var.registry_region, var.region)
  is_dev           = var.environment == "dev"
  secret_prefix    = var.service_name_prefix
  db_instance_name = "om-${var.environment}"
  db_name          = "open_mercato"
  db_user          = "open_mercato"

  # Cloud SQL socket path for Unix socket connections from Cloud Run.
  cloud_sql_socket_path = "/cloudsql/${google_sql_database_instance.main.connection_name}"
}

# ---------------------------------------------------------------------------
# Enable required GCP APIs
# ---------------------------------------------------------------------------

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "sts.googleapis.com",
    "iamcredentials.googleapis.com",
    "compute.googleapis.com",
    "sqladmin.googleapis.com",
  ])

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# ---------------------------------------------------------------------------
# Cloud SQL — Postgres 17
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "main" {
  name             = local.db_instance_name
  project          = var.project_id
  region           = var.region
  database_version = "POSTGRES_17"

  deletion_protection = !local.is_dev

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"

    backup_configuration {
      enabled = true
    }

    ip_configuration {
      ipv4_enabled    = !var.enable_private_ip
      private_network = var.enable_private_ip ? "projects/${var.project_id}/global/networks/${var.vpc_network}" : null
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = local.db_name
  instance = google_sql_database_instance.main.name
  project  = var.project_id
}

resource "random_password" "db_app_password" {
  length  = 32
  special = false
}

resource "random_password" "db_admin_password" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = local.db_user
  instance = google_sql_database_instance.main.name
  password = random_password.db_app_password.result
  project  = var.project_id
}

resource "google_sql_user" "admin" {
  name     = "postgres"
  instance = google_sql_database_instance.main.name
  password = random_password.db_admin_password.result
  project  = var.project_id
}

# ---------------------------------------------------------------------------
# Artifact Registry
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "open_mercato" {
  project       = var.project_id
  location      = local.registry_region
  repository_id = "open-mercato"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Random values for application secrets
# ---------------------------------------------------------------------------

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "random_password" "auth_secret" {
  length  = 64
  special = false
}

resource "random_password" "encryption_key" {
  length  = 32
  special = false
}

# ---------------------------------------------------------------------------
# Secret Manager secrets
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = "${local.secret_prefix}-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

locals {
  database_url = coalesce(
    var.database_url,
    "postgresql://${local.db_user}:${urlencode(random_password.db_app_password.result)}@${urlencode(local.cloud_sql_socket_path)}/${local.db_name}"
  )
  database_admin_url = "postgresql://postgres:${urlencode(random_password.db_admin_password.result)}@${urlencode(local.cloud_sql_socket_path)}/${local.db_name}"
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = local.database_url
}

resource "google_secret_manager_secret" "database_admin_url" {
  count     = local.is_dev ? 1 : 0
  project   = var.project_id
  secret_id = "${local.secret_prefix}-database-admin-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_admin_url" {
  count       = local.is_dev ? 1 : 0
  secret      = google_secret_manager_secret.database_admin_url[0].id
  secret_data = local.database_admin_url
}

resource "google_secret_manager_secret" "jwt_secret" {
  project   = var.project_id
  secret_id = "${local.secret_prefix}-jwt-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "jwt_secret" {
  secret      = google_secret_manager_secret.jwt_secret.id
  secret_data = random_password.jwt_secret.result
}

resource "google_secret_manager_secret" "auth_secret" {
  project   = var.project_id
  secret_id = "${local.secret_prefix}-auth-secret"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "auth_secret" {
  secret      = google_secret_manager_secret.auth_secret.id
  secret_data = random_password.auth_secret.result
}

resource "google_secret_manager_secret" "encryption_key" {
  project   = var.project_id
  secret_id = "${local.secret_prefix}-encryption-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "encryption_key" {
  secret      = google_secret_manager_secret.encryption_key.id
  secret_data = random_password.encryption_key.result
}

# ---------------------------------------------------------------------------
# GitHub Actions Service Account + OIDC Workload Identity
# ---------------------------------------------------------------------------

resource "google_service_account" "github_actions" {
  project      = var.project_id
  account_id   = "${local.secret_prefix}-github-actions"
  display_name = "GitHub Actions — ${var.environment}"
}

locals {
  github_sa_roles = [
    "roles/artifactregistry.writer",
    "roles/run.admin",
    "roles/iam.serviceAccountUser",
    "roles/secretmanager.secretAccessor",
    "roles/secretmanager.viewer",
    "roles/logging.viewer",
    "roles/cloudsql.client",
  ]
}

resource "google_project_iam_member" "github_actions_roles" {
  for_each = toset(local.github_sa_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${local.secret_prefix}-github-pool"
  display_name              = "GitHub Actions pool — ${var.environment}"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "${local.secret_prefix}-github-provider"
  display_name                       = "GitHub OIDC — ${var.environment}"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  attribute_condition = "assertion.repository == '${var.github_org}/${var.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_oidc_binding" {
  service_account_id = google_service_account.github_actions.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_org}/${var.github_repo}"
}

# ---------------------------------------------------------------------------
# Grant default Compute SA access to secrets (for Cloud Run)
# ---------------------------------------------------------------------------

data "google_project" "project" {
  project_id = var.project_id
}

resource "google_project_iam_member" "compute_sa_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"

  depends_on = [google_project_service.apis]
}
