#!/usr/bin/env bash
# pg_dump | gzip | age (X25519 recipient, authenticated encryption) -> /backups/tickdoctor-YYYY-MM-DD.sql.gz.age
# The server only knows BACKUP_AGE_RECIPIENT (public key); it cannot decrypt its own backups.
# Plaintext never touches the disk. Because the server cannot decrypt to verify, the plaintext stream is verified
# on the fly (tee): it must be a complete gzip whose tail holds pg_dump's "dump complete" marker.
# A failed/truncated dump never replaces a good file and never triggers the 14-day cleanup.
# Env: BACKUP_AGE_RECIPIENT (required), PGHOST/PGUSER/PGPASSWORD/PGDATABASE, BACKUP_DIR (/backups),
#      BACKUP_ONCE=1 (run once and exit, for tests), DUMP_CMD (test override of the dump command).
set -o pipefail
umask 077
BACKUP_DIR=${BACKUP_DIR:-/backups}
: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT (age public key, starts with age1)}"
case "$BACKUP_AGE_RECIPIENT" in age1*) ;; *) echo "BACKUP_AGE_RECIPIENT must be an age public key (age1...)"; exit 1;; esac
DUMP_CMD=${DUMP_CMD:-pg_dump}
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

backup_once() {
  local f st
  f="$BACKUP_DIR/tickdoctor-$(date -u +%F).sql.gz.age"
  st="$f.verify"
  rm -f "$f.tmp" "$st"
  # tee feeds a verifier (complete gzip + dump-complete marker) with the same stream that gets encrypted
  if $DUMP_CMD | gzip | tee >(gunzip | tail -n 10 | grep -q 'PostgreSQL database dump complete'; echo $? > "$st") \
        | age -r "$BACKUP_AGE_RECIPIENT" > "$f.tmp"; then
    for _ in $(seq 1 60); do [ -s "$st" ] && break; sleep 1; done
    if [ "$(cat "$st" 2>/dev/null)" = 0 ] && [ -s "$f.tmp" ] \
       && [ "$(head -c 21 "$f.tmp")" = "age-encryption.org/v1" ]; then
      mv "$f.tmp" "$f"
      rm -f "$st"
      find "$BACKUP_DIR" -name 'tickdoctor-*.sql.gz*' -mtime +14 -delete
      echo "backup ok $(date -u +%FT%TZ) $(basename "$f") $(stat -c %s "$f") bytes"
      return 0
    fi
  fi
  echo "backup FAILED $(date -u +%FT%TZ)"
  rm -f "$f.tmp" "$st"
  return 1
}

if [ "${BACKUP_ONCE:-}" = 1 ]; then backup_once; exit $?; fi
while true; do
  backup_once
  sleep 86400
done
