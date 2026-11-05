#!/bin/sh
# Makes a local CA and a server certificate for Core, signed by that CA.
# Usage: make-cert.sh [out-dir]   (default: certs/ at the repo root, which is gitignored)
# The server cert covers localhost, 127.0.0.1 and this Mac's .local name (override with AUREN_CERT_HOST).
set -eu
OUT="${1:-$(cd "$(dirname "$0")/../.." && pwd)/certs}"
HOST="${AUREN_CERT_HOST:-$( (scutil --get LocalHostName 2>/dev/null || hostname -s) ).local}"
mkdir -p "$OUT"
chmod 700 "$OUT"
cd "$OUT"
if [ ! -f ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
    -keyout ca.key -out ca.pem -subj "/CN=Auren Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
cat > server.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:$HOST
EXT
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout server.key -out server.csr -subj "/CN=$HOST" 2>/dev/null
# 825 days is the longest validity Apple platforms accept for a TLS server cert.
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 \
  -extfile server.ext -out server.pem 2>/dev/null
rm -f server.csr server.ext
chmod 600 ca.key server.key
echo "CA:     $OUT/ca.pem   (install this on iPhone; see docs/runbook.md)"
echo "Server: $OUT/server.pem, $OUT/server.key   (SANs: localhost, 127.0.0.1, $HOST)"
echo "Set AUREN_TLS_CERT=$OUT/server.pem AUREN_TLS_KEY=$OUT/server.key"
