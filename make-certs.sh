#!/bin/sh
# make-certs.sh
# Generates its own ECDSA-P-256 key pair with a self-signed certificate for each node.
# There is deliberately NO shared CA: every node is its own root, and each side trusts only the
# concretely pinned certificate of the other side (see agent-net.js).
# This means no one can issue a "valid" certificate for the network -- not even a real CA.
#
# Call without arguments (initial setup, in Git Bash):  sh make-certs.sh
#   -> generates thorsten + node2, if they don't exist yet.
#
# Call WITH a name (adding a new agent), e.g.:    sh make-certs.sh nova
#   -> generates only the certificate for "nova", leaves everything else untouched.
#   Afterward, still by hand: (1) add "nova" under "peers" in the hub's net-config.json,
#   (2) copy certs/nova-cert.pem AND certs/thorsten-cert.pem to the new laptop
#       (certs/nova-key.pem stays SECRET, only there), (3) set up net-config.json there with
#       self:"nova", role:"node", agentName, domain, piperVoice.
#
# Result in certs/:  <name>-key.pem (SECRET, never share) and <name>-cert.pem (may be shared)

set -e
cd "$(dirname "$0")"
mkdir -p certs

# Git Bash otherwise converts arguments that look like Unix paths ("/CN=...") into Windows paths,
# destroying the subject string. This turns that conversion off.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

if [ "$#" -gt 0 ]; then
  NAMES="$@"
else
  NAMES="thorsten node2"
fi

for NAME in $NAMES; do
  if [ -f "certs/$NAME-key.pem" ]; then
    echo "certs/$NAME-key.pem already exists -- will NOT be overwritten."
    continue
  fi
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "certs/$NAME-key.pem" -out "certs/$NAME-cert.pem" \
    -days 3650 -nodes -subj "/CN=$NAME" \
    -addext "subjectAltName=DNS:$NAME" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=serverAuth,clientAuth" 2>/dev/null
  echo "generated: certs/$NAME-key.pem + certs/$NAME-cert.pem"
done

echo
echo "SHA-256 fingerprints:"
for NAME in $NAMES; do
  printf '  %-10s ' "$NAME"
  openssl x509 -in "certs/$NAME-cert.pem" -noout -fingerprint -sha256 | sed 's/.*=//'
done
