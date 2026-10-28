#!/usr/bin/env bash
# Run from the project root so assets and log files have predictable locations.
set -o pipefail
cd -- "$(dirname -- "$0")" || exit 1

: > log.txt || exit 1
: > error.txt || exit 1

# WebKit and the native host can both write routine diagnostics to stderr.
# Classify the combined output by severity instead of by stream.
cargo run -- "$@" 2>&1 | awk '
    tolower($0) ~ /(^|[^[:alnum:]_])(error|errors|fatal|panic|panicked|exception|failed)([^[:alnum:]_]|$)/ {
        print >> "error.txt"; fflush("error.txt"); next
    }
    { print >> "log.txt"; fflush("log.txt") }
'
