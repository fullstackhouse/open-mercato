terraform {
  required_version = ">= 1.0"

  backend "gcs" {
    # Set bucket via -backend-config="bucket=<project-id>-terraform-state"
    prefix = "terraform/open-mercato"
  }

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

provider "google" {
  project = var.project_id
  region  = var.region
}
