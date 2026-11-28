terraform {
  required_version = ">= 1.15.5, < 2.0"
}

variable "lease_id" {
  type = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.lease_id))
    error_message = "lease_id must be a 32-character lowercase hexadecimal UUID."
  }
}

resource "terraform_data" "virtualbox_lease" {
  input            = var.lease_id
  triggers_replace = var.lease_id

  provisioner "local-exec" {
    interpreter = ["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
    command     = "& $env:DEVVM_PYTHON -I $env:DEVVM_HOST --config $env:DEVVM_CONFIG materialize ${self.input}; exit $LASTEXITCODE"
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
    command     = "& $env:DEVVM_PYTHON -I $env:DEVVM_HOST --config $env:DEVVM_CONFIG dematerialize ${self.input}; exit $LASTEXITCODE"
  }
}
