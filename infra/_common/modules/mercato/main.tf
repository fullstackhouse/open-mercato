# --- Cloud Run Service ---

resource "google_cloud_run_v2_service" "app" {
  name     = var.service_name_prefix
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [var.cloud_sql_connection_name]
      }
    }

    containers {
      image = "${local.registry_region}-docker.pkg.dev/${var.project_id}/open-mercato/${var.service_name_prefix}:latest"

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "APP_ENV"
        value = var.app_env
      }

      env {
        name  = "APP_URL"
        value = var.app_url
      }

      env {
        name  = "AUTO_SPAWN_WORKERS"
        value = "true"
      }

      env {
        name  = "AUTO_SPAWN_SCHEDULER"
        value = "true"
      }

      env {
        name  = "QUEUE_STRATEGY"
        value = "local"
      }

      env {
        name  = "CACHE_STRATEGY"
        value = "memory"
      }

      env {
        name  = "SELF_SERVICE_ONBOARDING_ENABLED"
        value = "true"
      }

      env {
        name  = "DEMO_MODE"
        value = "true"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.database_secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = var.jwt_secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "AUTH_SECRET"
        value_source {
          secret_key_ref {
            secret  = var.auth_secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "TENANT_DATA_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = var.encryption_key_secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        tcp_socket {
          port = 3000
        }
        initial_delay_seconds = 10
        timeout_seconds       = 3
        period_seconds        = 5
        failure_threshold     = 20
      }

      liveness_probe {
        tcp_socket {
          port = 3000
        }
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "public_access" {
  location = google_cloud_run_v2_service.app.location
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Cloud Run Migration Job ---

resource "google_cloud_run_v2_job" "migrations" {
  name     = "${var.service_name_prefix}-migrations"
  location = var.region

  template {
    template {
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.cloud_sql_connection_name]
        }
      }

      containers {
        image = "${local.registry_region}-docker.pkg.dev/${var.project_id}/open-mercato/${var.service_name_prefix}:latest"
        args  = ["yarn", "db:migrate"]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = var.database_secret_id
              version = "latest"
            }
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }

        env {
          name  = "APP_ENV"
          value = var.app_env
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
      }

      max_retries = 0
      timeout     = "1200s"
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      template[0].template[0].containers[0].args,
      template[0].template[0].containers[0].env,
      client,
      client_version
    ]
  }
}

# --- Domain Mapping (optional) ---

resource "google_cloud_run_domain_mapping" "app" {
  count    = var.enable_domain_mapping ? 1 : 0
  location = var.region
  name     = var.domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name       = google_cloud_run_v2_service.app.name
    certificate_mode = "AUTOMATIC"
  }

  depends_on = [google_cloud_run_v2_service.app]
}

locals {
  registry_region = coalesce(var.registry_region, var.region)
}
