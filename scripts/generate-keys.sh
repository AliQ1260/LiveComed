#!/bin/sh
# Generates the secrets Voltra's alerts need, using only openssl (no Node required).
# Run:  sh scripts/generate-keys.sh
# Paste the output into Vercel -> Project -> Settings -> Environment Variables. Don't commit it.

set -e
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# VAPID keys are a P-256 key pair, base64url-encoded:
# public = 65-byte uncompressed point (end of the SPKI DER), private = 32-byte scalar (bytes 8-39 of the SEC1 DER)
openssl ecparam -name prime256v1 -genkey -noout -out "$tmp" 2>/dev/null
b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
public=$(openssl ec -in "$tmp" -pubout -outform DER 2>/dev/null | tail -c 65 | b64url)
private=$(openssl ec -in "$tmp" -outform DER 2>/dev/null | tail -c +8 | head -c 32 | b64url)

echo "VAPID_PUBLIC_KEY=$public"
echo "VAPID_PRIVATE_KEY=$private"
echo "ALERT_CHECK_SECRET=$(openssl rand -hex 32)"
