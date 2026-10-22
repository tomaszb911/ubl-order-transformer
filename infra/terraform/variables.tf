variable "project_id" {
  description = "GCP project to deploy into."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry."
  type        = string
  default     = "europe-west4"
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "ubl-order-transformer"
}

variable "image" {
  description = "Container image to deploy, e.g. europe-west4-docker.pkg.dev/<project>/services/ubl-order-transformer:<sha>."
  type        = string
}

variable "input_topic" {
  description = "Topic the partner system publishes UBL orders to."
  type        = string
  default     = "orders.ubl.received"
}

variable "input_subscription" {
  description = "Push subscription delivering input messages to the service."
  type        = string
  default     = "orders.ubl.received"
}

variable "output_topic" {
  description = "Topic receiving transformed JSON orders."
  type        = string
  default     = "orders.transformed"
}

variable "dead_letter_topic" {
  description = "Topic receiving messages the service gave up on (with the failure reason)."
  type        = string
  default     = "orders.failed"
}

variable "max_delivery_attempts" {
  description = "Attempts (incl. the first) before the service dead-letters a message failing with a retryable error."
  type        = number
  default     = 5

  validation {
    condition     = var.max_delivery_attempts >= 1
    error_message = "max_delivery_attempts must be at least 1."
  }
}

variable "undeliverable_max_delivery_attempts" {
  description = "Pub/Sub-level safety net: after this many failed pushes (e.g. the service is down or crashing) Pub/Sub forwards the raw message to the undeliverable topic. Must be greater than max_delivery_attempts."
  type        = number
  default     = 10

  validation {
    condition     = var.undeliverable_max_delivery_attempts >= 5 && var.undeliverable_max_delivery_attempts <= 100
    error_message = "Pub/Sub accepts between 5 and 100 delivery attempts."
  }
}

variable "retry_minimum_backoff" {
  description = "Minimum delay between redeliveries of a nacked message."
  type        = string
  default     = "10s"
}

variable "retry_maximum_backoff" {
  description = "Maximum delay between redeliveries of a nacked message."
  type        = string
  default     = "300s"
}

variable "min_instances" {
  description = "Minimum Cloud Run instances (0 = scale to zero)."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum Cloud Run instances."
  type        = number
  default     = 10
}

variable "log_level" {
  description = "Service log level."
  type        = string
  default     = "info"
}
