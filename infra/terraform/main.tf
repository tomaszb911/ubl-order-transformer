locals {
  required_apis = [
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
  ]
  undeliverable_topic  = "${var.input_topic}.undeliverable"
  pubsub_service_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_service" "apis" {
  for_each           = toset(local.required_apis)
  service            = each.value
  disable_on_destroy = false
}

# --------------------------------------------------------------------------------------
# Container registry
# --------------------------------------------------------------------------------------

resource "google_artifact_registry_repository" "services" {
  location      = var.region
  repository_id = "services"
  format        = "DOCKER"
  description   = "Container images of the order integration services."

  depends_on = [google_project_service.apis]
}

# --------------------------------------------------------------------------------------
# Service accounts (least privilege)
# --------------------------------------------------------------------------------------

# Identity the Cloud Run service runs as: may only publish to its output topics.
resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-run"
  display_name = "${var.service_name} runtime"
}

# Identity Pub/Sub uses to sign the OIDC token of push requests: may only invoke the service.
resource "google_service_account" "push_invoker" {
  account_id   = "${var.service_name}-push"
  display_name = "${var.service_name} Pub/Sub push invoker"
}

# --------------------------------------------------------------------------------------
# Pub/Sub topics
# --------------------------------------------------------------------------------------

resource "google_pubsub_topic" "input" {
  name       = var.input_topic
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "output" {
  name       = var.output_topic
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "dead_letter" {
  name                       = var.dead_letter_topic
  message_retention_duration = "604800s" # keep failed orders for 7 days for investigation/replay
  depends_on                 = [google_project_service.apis]
}

resource "google_pubsub_topic" "undeliverable" {
  name                       = local.undeliverable_topic
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.apis]
}

resource "google_pubsub_topic_iam_member" "runtime_publishes_output" {
  for_each = {
    output      = google_pubsub_topic.output.name
    dead_letter = google_pubsub_topic.dead_letter.name
  }
  topic  = each.value
  role   = "roles/pubsub.publisher"
  member = google_service_account.runtime.member
}

# --------------------------------------------------------------------------------------
# Cloud Run service
# --------------------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "service" {
  name                = var.service_name
  location            = var.region
  deletion_protection = false
  # Only reachable through Google infrastructure (Pub/Sub push); no public traffic.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      env {
        name  = "PUBLISHER"
        value = "pubsub"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "OUTPUT_TOPIC"
        value = google_pubsub_topic.output.name
      }
      env {
        name  = "DEAD_LETTER_TOPIC"
        value = google_pubsub_topic.dead_letter.name
      }
      env {
        name  = "MAX_DELIVERY_ATTEMPTS"
        value = tostring(var.max_delivery_attempts)
      }
      env {
        name  = "LOG_LEVEL"
        value = var.log_level
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "push_invoker" {
  name     = google_cloud_run_v2_service.service.name
  location = google_cloud_run_v2_service.service.location
  role     = "roles/run.invoker"
  member   = google_service_account.push_invoker.member
}

# --------------------------------------------------------------------------------------
# Push subscription: orders.ubl.received -> Cloud Run
# --------------------------------------------------------------------------------------

# Pub/Sub must be able to mint OIDC tokens for the push identity.
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.push_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_service_agent
}

resource "google_pubsub_subscription" "input_push" {
  name  = var.input_subscription
  topic = google_pubsub_topic.input.id

  ack_deadline_seconds       = 30
  message_retention_duration = "604800s"

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.service.uri}/pubsub/push"

    oidc_token {
      service_account_email = google_service_account.push_invoker.email
      audience              = google_cloud_run_v2_service.service.uri
    }
  }

  # 5xx (transient failure) -> redelivery with exponential backoff.
  retry_policy {
    minimum_backoff = var.retry_minimum_backoff
    maximum_backoff = var.retry_maximum_backoff
  }

  # Safety net for when the service cannot answer at all. Normal failures are
  # dead-lettered by the service itself (to orders.failed, with the reason) after
  # MAX_DELIVERY_ATTEMPTS; this policy also makes Pub/Sub send `deliveryAttempt`.
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.undeliverable.id
    max_delivery_attempts = var.undeliverable_max_delivery_attempts
  }

  expiration_policy {
    ttl = "" # never expire
  }

  depends_on = [
    google_cloud_run_v2_service_iam_member.push_invoker,
    google_service_account_iam_member.pubsub_token_creator,
  ]

  lifecycle {
    precondition {
      condition     = var.undeliverable_max_delivery_attempts > var.max_delivery_attempts
      error_message = "undeliverable_max_delivery_attempts must exceed max_delivery_attempts, otherwise Pub/Sub dead-letters before the service does."
    }
  }
}

# Pub/Sub's service agent forwards undeliverable messages and acks them on the source subscription.
resource "google_pubsub_topic_iam_member" "pubsub_agent_publishes_undeliverable" {
  topic  = google_pubsub_topic.undeliverable.name
  role   = "roles/pubsub.publisher"
  member = local.pubsub_service_agent
}

resource "google_pubsub_subscription_iam_member" "pubsub_agent_subscribes_input" {
  subscription = google_pubsub_subscription.input_push.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}

# Keeps failed and undeliverable messages until someone inspects or replays them.
resource "google_pubsub_subscription" "dead_letter_inspection" {
  for_each = {
    failed        = google_pubsub_topic.dead_letter
    undeliverable = google_pubsub_topic.undeliverable
  }
  name                       = "${each.value.name}.inspection"
  topic                      = each.value.id
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}
