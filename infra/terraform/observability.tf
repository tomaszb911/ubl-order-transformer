# Log-based metrics built from the structured log line written for every processed message
# (see OrderProcessor.logResult): { outcome, durationMs, errorCode, messageId, ... }.

locals {
  processed_message_filter = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${var.service_name}"
    jsonPayload.outcome:*
  EOT
}

resource "google_logging_metric" "processing_duration" {
  name        = "${var.service_name}/processing_duration"
  description = "Time spent processing one Pub/Sub message, by outcome."
  filter      = local.processed_message_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"

    labels {
      key         = "outcome"
      value_type  = "STRING"
      description = "transformed | rejected | already-dead-lettered"
    }
  }

  value_extractor = "EXTRACT(jsonPayload.durationMs)"
  label_extractors = {
    outcome = "EXTRACT(jsonPayload.outcome)"
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 20
      growth_factor      = 2
      scale              = 1
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "processed_messages" {
  name        = "${var.service_name}/processed_messages"
  description = "Processed Pub/Sub messages, by outcome and error code."
  filter      = local.processed_message_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"

    labels {
      key        = "outcome"
      value_type = "STRING"
    }
    labels {
      key        = "error_code"
      value_type = "STRING"
    }
  }

  label_extractors = {
    outcome    = "EXTRACT(jsonPayload.outcome)"
    error_code = "EXTRACT(jsonPayload.errorCode)"
  }

  depends_on = [google_project_service.apis]
}
