terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.0"
    }
  }

  # Remote state for shared environments, e.g.:
  # backend "gcs" {
  #   bucket = "<project>-terraform-state"
  #   prefix = "ubl-order-transformer"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
