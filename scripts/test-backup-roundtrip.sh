#!/usr/bin/env bash
# Round-trip test of backup/backup.sh with a real pg_dump from a SCRATCH postgres:17 (the dev stack is not touched):
# builds the backup image, seeds data, runs one backup, checks mode/header, decrypts with the throwaway identity,
# restores into a second scratch DB and compares rows; tamper (flipped byte), wrong key and failed-dump cases must fail;
# cleanup runs only on success. Exit 0 = all good.
set -u
cd "$(dirname "$0")/.."
NET=td-bk-$$; PG=td-bk-pg-$$; IMG=tickdoctor-backup-test; TMP=$(mktemp -d); chmod 777 "$TMP"
trap 'docker rm -f $PG >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
docker build -q -t $IMG backup >/dev/null || fail "image build (age via apt)"
docker network create $NET >/dev/null
docker run -d --name $PG --network $NET -e POSTGRES_PASSWORD=pw -e POSTGRES_USER=td -e POSTGRES_DB=src postgres:17 >/dev/null
for _ in $(seq 1 40); do docker exec $PG pg_isready -U td -d src >/dev/null 2>&1 && break; sleep 1; done
sleep 2
psql_() { docker exec -i $PG psql -v ON_ERROR_STOP=1 -q -U td "$@"; }
psql_ -d src -c "create table t(id int primary key, v text); insert into t select g, 'row-'||g||repeat('x',50) from generate_series(1,20000) g;" || fail "seed"
SUM_SRC=$(psql_ -d src -Atc "select count(*), md5(string_agg(v,',' order by id)) from t")

run() { # $1 = extra env args; runs one backup into /backups (the bind mount $TMP)
  docker run --rm --network $NET -v "$TMP:/backups" -e PGHOST=$PG -e PGUSER=td -e PGDATABASE=src -e PGPASSWORD=pw -e BACKUP_ONCE=1 "$@" $IMG
}
age_() { docker run --rm --entrypoint "$1" -v "$TMP:/backups" -i $IMG "${@:2}"; }

age_ age-keygen -o /backups/id1.txt >/dev/null 2>&1; age_ age-keygen -o /backups/id2.txt >/dev/null 2>&1
R1=$(docker run --rm --entrypoint age-keygen -v "$TMP:/backups" $IMG -y /backups/id1.txt)
[[ $R1 == age1* ]] || fail "recipient from keygen"
# an old file that cleanup must remove only after a successful backup
touch -t 202001010000 "$TMP/tickdoctor-2020-01-01.sql.gz.age"

# 1. a failing dump: no new file, old file stays
run -e BACKUP_AGE_RECIPIENT=$R1 -e DUMP_CMD="bash -c 'echo partial; exit 1'" >/dev/null 2>&1 && fail "failed dump reported success"
ls "$TMP"/tickdoctor-$(date -u +%F)* >/dev/null 2>&1 && fail "file left behind after failed dump"
[ -e "$TMP/tickdoctor-2020-01-01.sql.gz.age" ] || fail "cleanup ran after a failed backup"
ok "failed dump: no file, no cleanup"
# 1b. truncated gzip-complete but no dump-complete marker
run -e BACKUP_AGE_RECIPIENT=$R1 -e DUMP_CMD="echo not-a-dump" >/dev/null 2>&1 && fail "dump without completion marker accepted"
ok "dump without 'dump complete' marker rejected"

# 2. real backup
run -e BACKUP_AGE_RECIPIENT=$R1 || fail "backup run"
F=$(ls "$TMP"/tickdoctor-$(date -u +%F).sql.gz.age 2>/dev/null) || fail "no backup file"
[ "$(head -c 21 "$F")" = "age-encryption.org/v1" ] || fail "age header"
[ "$(stat -f %Lp "$F" 2>/dev/null || stat -c %a "$F")" = 600 ] || fail "mode not 600"
[ -e "$TMP/tickdoctor-2020-01-01.sql.gz.age" ] && fail "cleanup did not remove old file after success"
ls "$TMP" | grep -qE 'tmp|verify' && fail "temp files left"
grep -q "row-1xxxx" "$F" && fail "plaintext found in the encrypted file"
ok "backup written, age header, mode 600, old file cleaned, no temp files, no plaintext"

# 3. decrypt + restore into a scratch DB and compare
age_ age -d -i /backups/id1.txt /backups/$(basename "$F") | gunzip > "$TMP/restore.sql" || fail "decrypt/gunzip"
psql_ -d postgres -c "create database restored" || fail "create db"
docker exec -i $PG psql -v ON_ERROR_STOP=1 -q -U td -d restored < "$TMP/restore.sql" >/dev/null || fail "restore"
SUM_DST=$(psql_ -d restored -Atc "select count(*), md5(string_agg(v,',' order by id)) from t")
[ "$SUM_SRC" = "$SUM_DST" ] || fail "restored data differs ($SUM_SRC vs $SUM_DST)"
ok "round trip: restored DB identical ($SUM_DST)" 

# 4. wrong key
if age_ age -d -i /backups/id2.txt /backups/$(basename "$F") >"$TMP/out.wrong" 2>/dev/null; then fail "wrong key decrypted"; fi
[ -s "$TMP/out.wrong" ] && fail "wrong key produced output"
ok "wrong key fails, no output"

# 5. tamper: flip one byte in the middle of the payload
SIZE=$(stat -f %z "$F" 2>/dev/null || stat -c %s "$F"); OFF=$((SIZE/2))
cp "$F" "$TMP/tampered.age"
python3 - "$TMP/tampered.age" $OFF <<'P'
import sys
p,o=sys.argv[1],int(sys.argv[2]); b=bytearray(open(p,'rb').read()); b[o]^=1; open(p,'wb').write(b)
P
if age_ age -d -i /backups/id1.txt /backups/tampered.age 2>/dev/null | gunzip >/dev/null 2>&1; then fail "tampered file decrypted cleanly"; fi
age_ age -d -i /backups/id1.txt /backups/tampered.age >/dev/null 2>"$TMP/tamper.err"; [ $? -ne 0 ] || fail "tampered file: age exit 0"
ok "flipped byte: decryption fails ($(head -c 80 "$TMP/tamper.err" | tr '\n' ' '))"
echo "ALL OK"
