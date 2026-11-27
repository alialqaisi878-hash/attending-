#!/usr/bin/env bash
# تنصيب/تحديث برنامج الحضور للشركات (نسخة البيع) على سيرفر فيه Traefik
# الاستعمال أول مرة:   bash install.sh hudoor.example.com
# التحديث بعدين:        bash install.sh
# هذا البرنامج منفصل تماماً عن أي برنامج ثاني بالسيرفر: مجلده وحاويته واسم الراوتر مالته خاصة بيه.
set -euo pipefail

DOMAIN="${1:-}"
BASE=/root/hudoor-saas
NAME=hudoor-saas
# مصدر الكود: ينحفظ بملف .env أول مرة، وبعدين التحديث ياخذه من هناك
envget() { [ -f "$BASE/.env" ] && grep "^$1=" "$BASE/.env" | cut -d= -f2- || true; }
REPO="${REPO:-$(envget REPO)}"; REPO="${REPO:-https://github.com/alialqaisi878-hash/hudoor-saas.git}"
BRANCH="${BRANCH:-$(envget BRANCH)}"; BRANCH="${BRANCH:-main}"

if [ -z "$DOMAIN" ] && [ -f "$BASE/.env" ]; then DOMAIN=$(grep '^DOMAIN=' "$BASE/.env" | cut -d= -f2-); fi
if [ -z "$DOMAIN" ]; then echo "اكتب الدومين بعد الأمر، مثال: bash install.sh hudoor.example.com"; exit 1; fi
command -v docker >/dev/null || { echo "Docker غير موجود على السيرفر"; exit 1; }
mkdir -p "$BASE/data"

# 1) الكود
if [ -d "$BASE/src/.git" ] && [ "$(git -C "$BASE/src" remote get-url origin)" != "$REPO" ]; then rm -rf "$BASE/src"; fi
if [ -d "$BASE/src/.git" ]; then git -C "$BASE/src" fetch --depth 1 origin "$BRANCH" && git -C "$BASE/src" checkout -q -B "$BRANCH" FETCH_HEAD
else git clone --depth 1 -b "$BRANCH" "$REPO" "$BASE/src"; fi
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
if [ -f "$BASE/src/deploy/install.sh" ] && [ "$SELF" != "$(readlink -f "$BASE/src/deploy/install.sh")" ]; then cp "$BASE/src/deploy/install.sh" "$SELF" 2>/dev/null || true; fi

# 2) نتعرف على Traefik الموجود
TRAEFIK=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /traefik/ {print $1; exit}')
[ -n "$TRAEFIK" ] || { echo "ما لكيت Traefik شغال على السيرفر"; exit 1; }
NETWORK=$(docker inspect "$TRAEFIK" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | head -n1)
ARGS=$(docker inspect "$TRAEFIK" -f '{{range .Args}}{{println .}}{{end}}{{range .Config.Cmd}}{{println .}}{{end}}')
RESOLVER=$(echo "$ARGS" | sed -n 's/^--certificate[sS]*[rR]esolvers\.\([^.]*\)\..*/\1/p' | head -n1)
WEB_EP=$(echo "$ARGS" | sed -n 's/^--entry[pP]oints\.\([^.]*\)\.address=:80$/\1/p' | head -n1)
SECURE_EP=$(echo "$ARGS" | sed -n 's/^--entry[pP]oints\.\([^.]*\)\.address=:443$/\1/p' | head -n1)
RESOLVER=${RESOLVER:-mytlschallenge}; WEB_EP=${WEB_EP:-web}; SECURE_EP=${SECURE_EP:-websecure}
echo "Traefik: $TRAEFIK | network: $NETWORK | resolver: $RESOLVER"

# 3) الإعدادات (باسورد صاحب البرنامج يتولد مرة وحدة)
FIRST_INSTALL=0
if [ ! -f "$BASE/.env" ]; then
  FIRST_INSTALL=1
  PASS=$(openssl rand -hex 8 2>/dev/null || (set +o pipefail; tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16))
  printf 'DOMAIN=%s\nSUPER_PASSWORD=%s\n' "$DOMAIN" "$PASS" > "$BASE/.env"
  chmod 600 "$BASE/.env"
else
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" "$BASE/.env"
fi
for kv in "REPO=$REPO" "BRANCH=$BRANCH"; do
  k=${kv%%=*}; grep -v "^$k=" "$BASE/.env" > "$BASE/.env.tmp" || true; echo "$kv" >> "$BASE/.env.tmp"; mv "$BASE/.env.tmp" "$BASE/.env"; chmod 600 "$BASE/.env"
done

cat > "$BASE/docker-compose.yml" <<YML
services:
  app:
    build: ./src
    container_name: $NAME
    restart: unless-stopped
    env_file: .env
    environment:
      - DATA_DIR=/data
      - VAPID_SUBJECT=https://$DOMAIN
    volumes:
      - ./data:/data
    networks: [proxy]
    labels:
      - traefik.enable=true
      - traefik.docker.network=$NETWORK
      - traefik.http.routers.$NAME.rule=Host(\`$DOMAIN\`)
      - traefik.http.routers.$NAME.entrypoints=$SECURE_EP
      - traefik.http.routers.$NAME.tls=true
      - traefik.http.routers.$NAME.tls.certresolver=$RESOLVER
      - traefik.http.routers.$NAME-http.rule=Host(\`$DOMAIN\`)
      - traefik.http.routers.$NAME-http.entrypoints=$WEB_EP
      - traefik.http.routers.$NAME-http.middlewares=$NAME-https
      - traefik.http.middlewares.$NAME-https.redirectscheme.scheme=https
      - traefik.http.services.$NAME.loadbalancer.server.port=3000
networks:
  proxy:
    external: true
    name: $NETWORK
YML

# 4) التشغيل
cd "$BASE"
docker compose -p "$NAME" build
docker compose -p "$NAME" up -d
sleep 4
if [ "$(docker inspect -f '{{.State.Status}}' $NAME 2>/dev/null)" != "running" ]; then
  echo "!! البرنامج ما اشتغل. هذا آخر السجل:"; docker logs --tail 40 $NAME 2>&1 || true; exit 1
fi

echo
echo "=============================================="
echo " الصفحة الرئيسية:       https://$DOMAIN"
echo " لوحة صاحب البرنامج:    https://$DOMAIN/super"
if [ "$FIRST_INSTALL" = 1 ]; then
  echo " باسورد لوحة صاحب البرنامج: $(grep '^SUPER_PASSWORD=' "$BASE/.env" | cut -d= -f2-)"
  echo " (غيّره من اللوحة بعد أول دخول)"
else
  echo " تم التحديث. بيانات كل الشركات ما تغيرت."
fi
echo " النسخ الاحتياطية اليومية: $BASE/data/backups"
echo "=============================================="
