#!/usr/bin/env bash
# تنصيب/تحديث برنامج الحضور والانصراف على سيرفر فيه Traefik (مثل قالب n8n من Hostinger)
# الاستعمال:  bash install.sh hudoor.example.com
set -euo pipefail

DOMAIN="${1:-}"
BASE=/root/attendance-app
REPO=https://github.com/alialqaisi878-hash/attending-.git

if [ -z "$DOMAIN" ] && [ -f "$BASE/.env" ]; then DOMAIN=$(grep '^DOMAIN=' "$BASE/.env" | cut -d= -f2-); fi
if [ -z "$DOMAIN" ]; then echo "اكتب الدومين بعد الأمر، مثال: bash install.sh hudoor.example.com"; exit 1; fi

command -v docker >/dev/null || { echo "Docker غير موجود على السيرفر"; exit 1; }
mkdir -p "$BASE/data"

# 1) الكود
if [ -d "$BASE/src/.git" ]; then git -C "$BASE/src" pull --ff-only; else git clone --depth 1 "$REPO" "$BASE/src"; fi
# نحدّث نسخة هذا السكربت نفسه للمرة الجاية
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
echo "Traefik: $TRAEFIK | network: $NETWORK | resolver: $RESOLVER | entrypoints: $WEB_EP / $SECURE_EP"

# 3) الإعدادات (كلمة مرور المدير تتولد مرة وحدة وتنحفظ)
FIRST_INSTALL=0
if [ ! -f "$BASE/.env" ]; then
  FIRST_INSTALL=1
  PASS=$(openssl rand -hex 8 2>/dev/null || (set +o pipefail; tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16))
  printf 'DOMAIN=%s\nADMIN_PASSWORD=%s\n' "$DOMAIN" "$PASS" > "$BASE/.env"
  chmod 600 "$BASE/.env"
else
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" "$BASE/.env"
fi

cat > "$BASE/docker-compose.yml" <<YML
services:
  attendance:
    build: ./src
    container_name: attendance-app
    restart: unless-stopped
    env_file: .env
    environment:
      - DB_PATH=/data/attendance.db
      - VAPID_SUBJECT=https://$DOMAIN
    volumes:
      - ./data:/data
    networks: [proxy]
    labels:
      - traefik.enable=true
      - traefik.docker.network=$NETWORK
      - traefik.http.routers.attendance.rule=Host(\`$DOMAIN\`)
      - traefik.http.routers.attendance.entrypoints=$SECURE_EP
      - traefik.http.routers.attendance.tls=true
      - traefik.http.routers.attendance.tls.certresolver=$RESOLVER
      - traefik.http.routers.attendance-http.rule=Host(\`$DOMAIN\`)
      - traefik.http.routers.attendance-http.entrypoints=$WEB_EP
      - traefik.http.routers.attendance-http.middlewares=attendance-https
      - traefik.http.middlewares.attendance-https.redirectscheme.scheme=https
      - traefik.http.services.attendance.loadbalancer.server.port=3000
networks:
  proxy:
    external: true
    name: $NETWORK
YML

# 4) التشغيل
cd "$BASE"
# نبني الصورة أول وبعدين نشغّل، ونتأكد إن البرنامج اشتغل فعلاً (حتى لو انقطع الاتصال بالنص)
docker compose build
for i in 1 2 3; do
  docker compose up -d
  sleep 4
  STATE=$(docker inspect -f '{{.State.Status}}' attendance-app 2>/dev/null || echo missing)
  [ "$STATE" = "running" ] && break
  echo "البرنامج بعده ما اشتغل ($STATE)، نحاول مرة ثانية..."
  docker start attendance-app >/dev/null 2>&1 || true
done
docker ps --filter name=attendance-app --format '{{.Names}}: {{.Status}}'
if [ "$(docker inspect -f '{{.State.Status}}' attendance-app 2>/dev/null)" != "running" ]; then
  echo "!! البرنامج ما اشتغل. هذا آخر السجل:"; docker logs --tail 40 attendance-app 2>&1 || true; exit 1
fi

echo
echo "=============================================="
echo " البرنامج:      https://$DOMAIN"
echo " لوحة المدير:   https://$DOMAIN/admin.html"
if [ "$FIRST_INSTALL" = 1 ]; then
  echo " كلمة مرور المدير: $(grep '^ADMIN_PASSWORD=' "$BASE/.env" | cut -d= -f2-)"
  echo " (تكدر تغيرها من الملف $BASE/.env ثم تعيد تشغيل هذا الأمر)"
else
  echo " تم التحديث. البيانات وكلمة مرور المدير ما تغيرت."
fi
echo "=============================================="
