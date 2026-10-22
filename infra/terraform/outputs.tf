output "service_url" {
  description = "Cloud Run service URL (internal ingress only)."
  value       = google_cloud_run_v2_service.service.uri
}

output "push_endpoint" {
  description = "Endpoint the push subscription delivers to."
  value       = google_pubsub_subscription.input_push.push_config[0].push_endpoint
}

output "image_repository" {
  description = "Artifact Registry path to push images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.services.repository_id}/${var.service_name}"
}

output "topics" {
  description = "Pub/Sub topics used by the service."
  value = {
    input         = google_pubsub_topic.input.name
    output        = google_pubsub_topic.output.name
    dead_letter   = google_pubsub_topic.dead_letter.name
    undeliverable = google_pubsub_topic.undeliverable.name
  }
}
