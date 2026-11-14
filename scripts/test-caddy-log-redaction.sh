#!/usr/bin/env bash
# Proves that Caddy ERROR log lines contain no client address, using the real Caddyfile.ingest log block.
# Runs a scratch Caddy + a slow-big-body upstream on a private docker network (no host ports), makes a client
# abort mid-response, then greps the Caddy log for the client IP. Also runs the same scenario with the error/msg
# redaction lines removed ("before"), which must LEAK (otherwise the test proves nothing -> exit 2).
# NOTE: in Caddy 2.10 the abort line ("aborting with incomplete response", error "writing: write tcp A->CLIENT:port: ...")
# is logged at WARN, so the shipped ERROR level already drops it. To exercise the regexp filter the test raises the level
# to WARN (cases before/after), and a third case runs the shipped level unchanged (must also be free of the client IP).
# Exit 0 = redaction works, 1 = IP in filtered log, 2 = could not reproduce the leak in the unfiltered run.
set -u
cd "$(dirname "$0")/.."
NET=td-caddytest-$$; SUBNET=172.29.77.0/24; CLIENT_IP=172.29.77.50
TMP=$(mktemp -d); trap 'docker rm -f td-ct-up-$$ td-ct-caddy-$$ >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; rm -rf "$TMP"' EXIT
docker network create --subnet $SUBNET $NET >/dev/null || exit 3

cat > "$TMP/up.py" <<'P'
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", str(200*1024*1024)); self.end_headers()
        chunk = b"x"*65536
        try:
            for _ in range(3200): self.wfile.write(chunk)
        except Exception: pass
    def log_message(self,*a): pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads=True
S(("0.0.0.0",9000),H).serve_forever()
P
docker run -d --name td-ct-up-$$ --network $NET -v "$TMP/up.py:/up.py:ro" python:3-alpine python /up.py >/dev/null || exit 3
UP_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" td-ct-up-$$)

# $1 = name, $2 = 1 to keep the redaction lines, 0 to remove them, $3 = log level override (empty = as shipped)
run_case() {
  local name=$1 keep=$2 cfg="$TMP/Caddyfile.$1"
  sed "s#reverse_proxy api:4000#reverse_proxy $UP_IP:9000#; s#:3001#:8080#" Caddyfile.ingest > "$cfg"
  [ -z "${3:-}" ] || sed -i.bak2 "s/level ERROR/level $3/" "$cfg"
  if [ "$keep" != 1 ]; then grep -vE '^[[:space:]]+(error|msg) regexp' "$cfg" > "$cfg.nf"; mv "$cfg.nf" "$cfg"; fi
  docker rm -f td-ct-caddy-$$ >/dev/null 2>&1
  docker run -d --name td-ct-caddy-$$ --network $NET -v "$cfg:/etc/caddy/Caddyfile:ro" caddy:2.10-alpine >/dev/null || return 3
  sleep 2
  for i in 1 2 3; do
    docker run --rm --network $NET --ip $CLIENT_IP curlimages/curl -s -o /dev/null -m 2 --limit-rate 200k "http://td-ct-caddy-$$:8080/v1/x" >/dev/null 2>&1
  done
  sleep 2
  docker logs td-ct-caddy-$$ > "$TMP/$name.log" 2>&1
  [ -z "${KEEPLOG:-}" ] || cp "$TMP/$name.log" "$KEEPLOG.$name"
}

run_case before 0 WARN || exit 3
run_case after 1 WARN || exit 3
run_case shipped 1 || exit 3
echo "--- log lines mentioning the error (before, no filter):"; grep -c . "$TMP/before.log" | sed 's/^/lines: /'; grep -m2 "$CLIENT_IP" "$TMP/before.log" | cut -c1-400
echo "--- after (filtered):"; grep -c . "$TMP/after.log" | sed 's/^/lines: /'; grep -m2 '"error"' "$TMP/after.log" | cut -c1-400
if ! grep -q "$CLIENT_IP" "$TMP/before.log"; then echo "RESULT: could not reproduce the client address in the unfiltered log (test inconclusive)"; exit 2; fi
if grep -q "$CLIENT_IP" "$TMP/after.log"; then echo "RESULT: FAIL, client IP present in filtered log"; exit 1; fi
if ! grep -q 'redacted' "$TMP/after.log"; then echo "RESULT: FAIL, no [redacted] marker (filter not applied?)"; exit 1; fi
if grep -q "$CLIENT_IP" "$TMP/shipped.log"; then echo "RESULT: FAIL, client IP present with the shipped config"; exit 1; fi
echo "RESULT: OK, leaks in the unfiltered log, redacted in the filtered one"
