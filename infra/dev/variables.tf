variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "github_org" {
  type    = string
  default = "open-mercato"
}

variable "github_repo" {
  type    = string
  default = "open-mercato"
}
