# Nightly encrypted Postgres backups. postgres:17 (Debian trixie) + `age` from the distro repository (1.2.x).
# The container only holds the PUBLIC age recipient; the private identity stays offline with the owner.
FROM postgres:17
RUN apt-get update \
 && apt-get install -y --no-install-recommends age \
 && rm -rf /var/lib/apt/lists/*
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 755 /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
