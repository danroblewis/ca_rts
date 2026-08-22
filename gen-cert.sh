#!/usr/bin/env bash
# Generate the self-signed TLS certificate used by server.py.
#
# WebGPU is only available in secure contexts (https:// or localhost), so the
# game must be served over TLS to be reachable from other machines. We don't
# need a "real" certificate: browsers let you click through the warning once.
#
# The generated cert.pem / key.pem are committed to the repo on purpose.
# Re-run this script to rotate them (valid for 10 years).
set -euo pipefail
cd "$(dirname "$0")"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout key.pem -out cert.pem \
    -subj "/CN=ca-rts" \
    -addext "subjectAltName=DNS:localhost,DNS:ca-rts,IP:127.0.0.1,IP:0.0.0.0" \
    -addext "basicConstraints=CA:FALSE" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth"

echo "Wrote cert.pem and key.pem:"
openssl x509 -in cert.pem -noout -subject -dates -ext subjectAltName
