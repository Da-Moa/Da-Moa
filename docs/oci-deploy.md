# OCI Ubuntu arm64 배포

GitHub Actions는 PR에서 `npm test`와 `npm run build`를 실행합니다. `main` push 또는 수동 실행 시 검증을 통과한 커밋을 SSH로 전송합니다. 서버는 arm64 앱 이미지를 빌드하고 Compose에서 앱·PostgreSQL·MinIO를 실행합니다. PostgreSQL과 MinIO는 각각 이름 있는 Docker 볼륨에 데이터를 저장합니다. 첫 배포에서는 빈 DB에 스키마를 만들고, 앱 전환 후 `/api/openapi.json` 점검에 실패하면 이전 앱 이미지로 되돌립니다. 배포용 앱 환경 파일은 배포가 끝나면 서버에서 삭제합니다.

## 1. 공인 IP와 인스턴스 준비

1. OCI Ubuntu arm64 인스턴스의 공인 IPv4를 확인합니다. 아래 예시의 `203.0.113.10`은 실제 공인 IP로 모두 바꿉니다. 인스턴스를 교체할 때도 IP를 유지하려면 예약 공인 IP를 선택합니다. **먼저 카카오 개발자 콘솔의 REST API 키에 `https://203.0.113.10/auth/v1/kakao` 형식의 Redirect URI를 등록할 수 있는지 확인하세요.** 카카오 공식 문서는 URI 일치 규칙을 설명하지만 숫자 IP의 등록 허용 여부는 명시하지 않습니다. 콘솔에서 거절하면 카카오 로그인을 위해 도메인이 필요합니다. [카카오 Redirect URI 설정](https://developers.kakao.com/docs/ko/app-setting/app)
2. OCI VCN 보안 목록 또는 NSG에서 TCP 22(SSH), 80(인증서 발급·HTTP 리다이렉트), 443(HTTPS)을 허용합니다. 인스턴스의 iptables에도 80·443을 허용합니다. OCI Ubuntu 이미지에서는 UFW로 기본 방화벽 규칙을 바꾸지 않습니다. **앱 3000, PostgreSQL 5432, MinIO 9000·9001은 외부에 열지 않습니다.** SSH는 가능하면 관리 IP로 제한하되 GitHub 호스팅 러너가 배포할 때 접근할 수 있어야 합니다. [OCI 보안 목록](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm), [Ubuntu 이미지 방화벽 안내](https://docs.oracle.com/en-us/iaas/Content/Compute/References/images.htm)
3. Nginx, curl, tar를 설치합니다. Node.js는 앱 이미지 안에 포함됩니다.

```bash
sudo apt update
sudo apt install -y curl nginx tar
```

OCI 기본 Ubuntu 이미지의 iptables가 웹 포트를 막고 있다면 다음처럼 허용하고 저장합니다. 기존 SSH·iSCSI 규칙은 삭제하지 않습니다.

```bash
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT || sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT || sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 2. Docker와 배포 계정 준비

[Docker 공식 Ubuntu 설치 안내](https://docs.docker.com/engine/install/ubuntu/)대로 arm64용 Docker Engine과 Compose 플러그인을 설치하고 `docker compose version`을 확인합니다. 운영에서는 [compose.production.yaml](../compose.production.yaml)의 앱·PostgreSQL·MinIO만 사용합니다. 개발용 `compose.yaml`은 사용하지 않습니다.

```bash
sudo adduser --disabled-password --gecos '' da-moa
sudo usermod -aG docker da-moa
sudo install -d -o da-moa -g da-moa -m 750 /srv/da-moa /srv/da-moa/releases /srv/da-moa/bootstrap
sudo install -d -o da-moa -g da-moa -m 700 /srv/da-moa/shared /home/da-moa/.ssh
sudo install -o da-moa -g da-moa -m 600 /dev/null /home/da-moa/.ssh/authorized_keys
sudo install -o da-moa -g da-moa -m 600 /dev/null /srv/da-moa/shared/.env.production
sudo install -o da-moa -g da-moa -m 600 /dev/null /srv/da-moa/shared/.minio.env
```

`docker` 그룹은 호스트 관리자 수준의 권한을 가집니다. 배포 SSH 키는 전용으로 생성하고 다른 용도에 쓰지 않습니다.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/da-moa-deploy-key -C da-moa-actions
cat ~/.ssh/da-moa-deploy-key.pub
```

서버에서 `sudoedit /home/da-moa/.ssh/authorized_keys`로 공개키를 넣고 소유권과 권한을 확인합니다. 이후 `ssh -i ~/.ssh/da-moa-deploy-key da-moa@203.0.113.10`으로 새 세션을 열어 Docker 그룹 권한을 적용합니다.

현재 공식 운영용 [MinIO AIStor 컨테이너](https://docs.min.io/aistor/installation/container/install/)에는 라이선스 파일이 필요합니다. 단일 인스턴스에는 공식 무료 티어 라이선스를 신청할 수 있습니다. Compose는 검증한 arm64 지원 이미지의 다이제스트를 고정해 사용합니다. 받은 `minio.license`를 다음처럼 서버에 설치합니다. 이 파일과 다음 환경 파일은 Git에 넣지 않습니다.

```bash
# 로컬 컴퓨터
scp minio.license ubuntu@203.0.113.10:/tmp/da-moa-minio.license
# OCI 인스턴스
sudo install -T -o da-moa -g da-moa -m 600 /tmp/da-moa-minio.license /srv/da-moa/shared/minio.license
test -f /srv/da-moa/shared/minio.license
```

서버에서 `sudoedit /srv/da-moa/shared/.minio.env`를 열고 MinIO 관리자 계정만 넣습니다.

```dotenv
MINIO_ROOT_USER=고유한_관리자_아이디
MINIO_ROOT_PASSWORD=길고_임의의_관리자_비밀번호
```

초기 저장소 실행에 사용할 `/srv/da-moa/shared/.env.production`을 준비합니다. 이후 운영 값은 GitHub `production` Environment Secret `OCI_PRODUCTION_ENV`에 **파일 전체 내용**을 등록하고, 배포가 서버 파일을 교체합니다. DB 비밀번호에 URL 예약 문자가 있으면 `DATABASE_URL`에서 퍼센트 인코딩합니다. MinIO 앱 전용 키는 다음 절에서 버킷을 만든 후 채웁니다.

```dotenv
POSTGRES_PASSWORD=openssl_rand_hex_32로_생성한_값
DATABASE_URL=postgresql://da_moa:위와_같은_비밀번호@postgres:5432/da_moa
AUTH_JWT_SECRET=32바이트_이상_임의_문자열
KAKAO_REST_API_KEY=카카오_REST_API_키
KAKAO_CLIENT_SECRET=
KAKAO_REDIRECT_URI=https://203.0.113.10/auth/v1/kakao
MINIO_ENDPOINT=http://minio:9000
MINIO_BUCKET=da-moa-receipts
MINIO_ACCESS_KEY=버킷_생성_후_채울_앱_전용_키
MINIO_SECRET_KEY=버킷_생성_후_채울_앱_전용_비밀_키
PORT=3000
```

`AUTH_JWT_SECRET`은 `openssl rand -base64 48`로 생성할 수 있습니다. 카카오 콘솔에 Redirect URI를 동일하게 등록하고 OpenID Connect를 활성화합니다. 카카오 REST API 키의 클라이언트 시크릿이 ON이면 `KAKAO_CLIENT_SECRET`에 **별도 코드**를 설정합니다. `KAKAO_REST_API_KEY`에 시크릿을 넣으면 안 됩니다. [카카오 토큰 요청](https://developers.kakao.com/docs/ko/kakaologin/rest-api)

`POSTGRES_PASSWORD`는 PostgreSQL 데이터 볼륨을 **처음 초기화할 때만** `da_moa` 계정에 적용됩니다. 이후 Secret의 값을 바꿔도 기존 DB 비밀번호는 바뀌지 않습니다. 마이그레이션에서 `password authentication failed for user "da_moa"`가 나오면 `POSTGRES_PASSWORD`와 `DATABASE_URL`의 비밀번호가 같은지 확인합니다. 특수문자가 있으면 URL 쪽 비밀번호는 퍼센트 인코딩해야 합니다. DB에 설정된 비밀번호를 변경해야 한다면 서버에서 다음 명령으로 `psql`에 들어가 `\password da_moa`를 실행하고, GitHub Secret에 넣을 새 비밀번호를 두 번 입력한 뒤 `\q`로 나옵니다. 데이터 볼륨은 유지됩니다. [PostgreSQL 공식 이미지](https://hub.docker.com/_/postgres), [psql 비밀번호 변경](https://www.postgresql.org/docs/17/sql-alterrole.html)

```bash
sudo docker exec -it da-moa-postgres-1 psql -U da_moa -d da_moa
```

## 3. 저장소 컨테이너 첫 실행

첫 배포 전에 [compose.production.yaml](../compose.production.yaml)을 서버의 `/srv/da-moa/bootstrap/compose.production.yaml`로 복사합니다.

```bash
# 로컬 컴퓨터
scp compose.production.yaml ubuntu@203.0.113.10:/tmp/da-moa-compose.yaml
# OCI 인스턴스
sudo install -o da-moa -g da-moa -m 640 /tmp/da-moa-compose.yaml /srv/da-moa/bootstrap/compose.production.yaml
```

배포 계정으로 새 SSH 세션을 열어 같은 디렉터리에 환경 파일 심볼릭 링크를 만듭니다.

```bash
ln -s /srv/da-moa/shared/.env.production /srv/da-moa/bootstrap/.env.production
ln -s /srv/da-moa/shared/.minio.env /srv/da-moa/bootstrap/.minio.env
docker compose -p da-moa --env-file /srv/da-moa/shared/.env.production -f /srv/da-moa/bootstrap/compose.production.yaml up -d --wait postgres minio
docker volume ls --filter name=da-moa_
```

같은 Compose 프로젝트명 `da-moa`를 이후 배포에서도 사용합니다. 첫 실행 시 `da-moa_postgres-data`와 `da-moa_minio-data` 볼륨이 생성됩니다. 앱 이미지를 다시 빌드하거나 컨테이너를 교체해도 이 볼륨은 유지됩니다. 배포 스크립트는 저장소 컨테이너에 `--no-recreate`를 적용하고 볼륨 삭제 명령을 실행하지 않습니다. [Docker의 Compose 볼륨 동작](https://docs.docker.com/reference/compose-file/volumes/)

이전 Compose 설정으로 먼저 실행해 `/srv/da-moa/shared/minio.license`가 디렉터리가 되었고 그 안에 `da-moa-minio.license`가 들어 있다면 다음처럼 복구합니다. `ubuntu` 계정에서도 실행할 수 있도록 절대 경로를 사용합니다. MinIO 컨테이너만 다시 만들며 저장 데이터 볼륨은 유지됩니다.

```bash
sudo bash -e <<'SH'
test -s /srv/da-moa/shared/minio.license/da-moa-minio.license
test ! -e /srv/da-moa/shared/minio.license.directory-backup
docker compose -p da-moa --env-file /srv/da-moa/shared/.env.production -f /srv/da-moa/bootstrap/compose.production.yaml stop minio
mv /srv/da-moa/shared/minio.license /srv/da-moa/shared/minio.license.directory-backup
install -T -o da-moa -g da-moa -m 600 /srv/da-moa/shared/minio.license.directory-backup/da-moa-minio.license /srv/da-moa/shared/minio.license
test -s /srv/da-moa/shared/minio.license
echo 'MinIO 라이선스 파일 확인됨'
docker compose -p da-moa --env-file /srv/da-moa/shared/.env.production -f /srv/da-moa/bootstrap/compose.production.yaml up -d --wait --force-recreate --no-deps minio
SH
```

콘솔에 접속하기 전에 라이선스 설치 상태를 확인합니다. AIStor는 라이선스가 없어도 콘솔이 열릴 수 있습니다. 서버에서 배포 계정으로 실행하고, 프롬프트에 `.minio.env`의 관리자 계정을 입력합니다. 비밀번호는 터미널에 표시되지 않습니다. 첫 명령에서 `확인됨`이 출력되지 않으면 라이선스 파일을 다시 복사한 뒤 진행합니다.

```bash
test -f /srv/da-moa/shared/minio.license && test -s /srv/da-moa/shared/minio.license && echo 'MinIO 라이선스 파일 확인됨'
read -r -p 'MinIO 관리자 아이디: ' minio_admin_user
read -r -s -p 'MinIO 관리자 비밀번호: ' minio_admin_password; echo
sudo docker compose -p da-moa --env-file /srv/da-moa/shared/.env.production -f /srv/da-moa/bootstrap/compose.production.yaml exec -T minio mc alias set da-moa http://127.0.0.1:9000 "$minio_admin_user" "$minio_admin_password"
unset minio_admin_user minio_admin_password
sudo docker compose -p da-moa --env-file /srv/da-moa/shared/.env.production -f /srv/da-moa/bootstrap/compose.production.yaml exec -T minio mc license update da-moa /minio.license
sudo docker compose -p da-moa --env-file /srv/da-moa/shared/.env.production -f /srv/da-moa/bootstrap/compose.production.yaml exec -T minio mc license info da-moa
```

`mc license info`에 라이선스 정보가 표시된 다음 콘솔 로그인을 진행합니다. `license update`가 실패하면 `docker compose -p da-moa --env-file /srv/da-moa/shared/.env.production -f /srv/da-moa/bootstrap/compose.production.yaml logs --tail=50 minio`로 오류를 확인하고, 내려받은 라이선스 파일과 `/minio.license` 마운트를 점검합니다. 볼륨을 삭제할 필요는 없습니다. [AIStor 라이선스 적용](https://docs.min.io/aistor/reference/cli/mc-license/mc-license-update/), [상태 확인](https://docs.min.io/aistor/reference/cli/mc-license/mc-license-info/)

MinIO의 S3 API와 콘솔은 서버의 `127.0.0.1:9000`, `127.0.0.1:9001`에만 바인딩합니다. 로컬 컴퓨터에서 `ssh -L 9001:127.0.0.1:9001 ubuntu@203.0.113.10`으로 터널을 연 뒤 `http://127.0.0.1:9001`에 접속합니다. `da-moa-receipts`라는 **비공개 버킷**을 만들고, 이 버킷의 객체 읽기·쓰기·삭제만 허용하는 앱 전용 사용자/키를 만듭니다. 앱에는 관리자 키 대신 이 키를 설정합니다. 정책 예시:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
    "Resource": ["arn:aws:s3:::da-moa-receipts/*"]
  }]
}
```

발급한 앱 전용 키를 GitHub `production` Environment Secret `OCI_PRODUCTION_ENV`의 `MINIO_ACCESS_KEY`·`MINIO_SECRET_KEY`에 넣습니다. 앱 컨테이너는 Compose 내부에서 `postgres:5432`와 `minio:9000`에 접속하며, Nginx는 호스트의 `127.0.0.1:3000`으로 프록시합니다. DB와 MinIO 포트는 OCI 보안 목록에 열지 않습니다.

**`docker compose down -v`, `docker volume rm`, `docker volume prune`를 운영 데이터 볼륨에 실행하지 마세요.** 볼륨은 인스턴스 디스크에 있으므로 인스턴스나 디스크 자체의 장애에는 별도 백업이 필요합니다. PostgreSQL 덤프와 MinIO 객체를 정기적으로 인스턴스 밖에 백업하고 복원도 확인합니다. DB 백업 예시:

```bash
docker exec -i da-moa-postgres-1 pg_dump -U da_moa -Fc da_moa > "$HOME/da-moa-$(date +%F).dump"
```

## 4. IP용 HTTPS 인증서와 Nginx

Let's Encrypt는 IP용 인증서를 발급합니다. 인증서는 약 6일간 유효하며 Certbot **5.4 이상**의 `webroot` 방식과 자동 갱신이 필요합니다. `certbot --nginx -d IP`는 IP 인증서를 설치하는 방법이 아닙니다. [Let's Encrypt의 IP 인증서 안내](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

먼저 `sudo install -d -m 755 /var/www/letsencrypt`를 실행하고 `/etc/nginx/sites-available/da-moa`에 HTTP 설정을 만듭니다. 인증서 발급 전에는 443 블록을 만들지 않습니다.

```nginx
server {
    listen 80;
    server_name 161.33.3.222;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / { return 301 https://$host$request_uri; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/da-moa /etc/nginx/sites-enabled/da-moa
sudo nginx -t
sudo systemctl reload nginx
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
certbot --version   # 5.4 이상 확인
```

인증서 요청 전에 80번 포트와 챌린지 파일이 실제로 제공되는지 확인합니다. 서버에서 다음을 실행하면 마지막 명령이 `ok`를 출력해야 합니다.

```bash
sudo ss -ltnp '( sport = :80 )'
sudo install -d -m 755 /var/www/letsencrypt/.well-known/acme-challenge
printf 'ok\n' | sudo tee /var/www/letsencrypt/.well-known/acme-challenge/check.txt >/dev/null
curl -fsS -H 'Host: 161.33.3.222' http://127.0.0.1/.well-known/acme-challenge/check.txt
```

이어서 **서버 밖의 컴퓨터**에서 `curl --max-time 10 -fsS http://161.33.3.222/.well-known/acme-challenge/check.txt`를 실행해 `ok`를 확인합니다. 로컬에서는 되는데 외부에서 접속 시간이 초과되면 OCI 인스턴스에 연결된 보안 목록 또는 NSG의 인바운드 규칙(소스 `0.0.0.0/0`, TCP, **목적지 포트 80**)과 인스턴스의 iptables 규칙을 확인합니다. 외부에서 파일을 읽을 수 있을 때 인증서를 요청합니다. [Let's Encrypt HTTP-01 포트](https://letsencrypt.org/docs/challenge-types/), [OCI 보안 목록](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm)

```bash
sudo rm /var/www/letsencrypt/.well-known/acme-challenge/check.txt
sudo certbot certonly --preferred-profile shortlived --webroot --webroot-path /var/www/letsencrypt --ip-address 161.33.3.222
```

발급 후 같은 파일에 다음 HTTPS 블록을 **추가**합니다. 위의 HTTP 80 블록과 `/.well-known/acme-challenge/` 위치는 갱신에 필요하므로 유지합니다. 앱은 `127.0.0.1:3000`에만 바인딩합니다.

```nginx
server {
    listen 443 ssl;
    server_name 161.33.3.222;
    ssl_certificate /etc/letsencrypt/live/161.33.3.222/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/161.33.3.222/privkey.pem;

    location = /internal/realtime { return 404; }
    location = /realtime {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 75s;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo sh -c 'printf "#!/bin/sh\nsystemctl reload nginx\n" > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh'
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run --run-deploy-hooks
systemctl list-timers | grep -i certbot
```

갱신 타이머와 deploy hook이 실제로 작동하는지 확인합니다. 80 포트의 인증 경로는 갱신에도 필요합니다. 첫 배포 전 프록시가 502를 반환해도 인증서 발급용 HTTP 경로가 열려 있으면 됩니다. 영수증 크기에 맞춰 Nginx `client_max_body_size`도 확인합니다.

`renew --dry-run`이 실패하면 마지막 요약 위에 있는 최초 오류를 확인합니다. `systemctl list-timers`는 다음 실행 일정만 보여 주며 갱신 성공을 보장하지 않습니다. 서버에서 `sudo nginx -t`, `sudo certbot certificates`, `sudo tail -n 120 /var/log/letsencrypt/letsencrypt.log`를 실행해 원인을 확인한 뒤 다시 모의 갱신합니다.

오류가 `Invalid response ... : 404`이면 포트 80 접속은 성공했지만 챌린지 파일이 제공되지 않은 것입니다. HTTP 80 블록의 `server_name`이 실제 IP이고, 챌린지 `location`의 `root`가 Certbot의 `--webroot-path`와 같은지 확인합니다. 위의 `check.txt` 테스트를 서버와 외부 컴퓨터에서 다시 수행해 `ok`가 나온 뒤 `sudo certbot renew --dry-run --run-deploy-hooks`를 재실행합니다.

## 5. GitHub 설정과 첫 배포

저장소 **Settings → Environments → production**을 만들고 배포 브랜치를 `main`으로 제한합니다. 여기에 다음 값들을 설정합니다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Variable | `OCI_HOST` | 인스턴스 공인 IP 또는 DNS 이름 |
| Variable | `OCI_USER` | `da-moa` |
| Secret | `OCI_SSH_PRIVATE_KEY` | 배포 전용 개인키 전체 내용 |
| Secret | `OCI_SSH_KNOWN_HOSTS` | 인스턴스 SSH 호스트 키의 `known_hosts` 한 줄 |
| Secret | `OCI_PRODUCTION_ENV` | `.env.production` 전체 내용(여러 줄 그대로 입력) |

`OCI_SSH_KNOWN_HOSTS`는 로컬에서 `ssh-keyscan -t ed25519 인스턴스_IP`로 얻을 수 있습니다. 등록 전에 이미 신뢰하는 SSH 접속에서 확인한 호스트 키 지문과 `ssh-keygen -lf` 결과를 대조합니다. 개인키를 Git이나 서버의 웹 루트에 복사하지 않습니다. `OCI_HOST`에는 `known_hosts`에 사용한 것과 같은 호스트를 넣습니다.

`OCI_PRODUCTION_ENV`에는 위의 `POSTGRES_PASSWORD`부터 `PORT`까지 실제 운영 값을 포함한 `.env.production` 전체 내용을 붙여 넣습니다. 이 Secret이 없거나 비어 있으면 배포는 서버 파일을 바꾸기 전에 중단합니다. Actions는 배포 중에만 서버의 `/srv/da-moa/shared/.env.production`을 권한 `600`으로 만들고, 성공·실패 시 업로드본과 함께 삭제합니다. 기존 배포에서 남은 환경 파일과 백업본도 삭제합니다. 값만 바꿨다면 **Actions → CI → Run workflow → main**을 다시 실행하면 같은 커밋에서도 앱 컨테이너를 재생성합니다. 환경 파일을 보관하지 않으므로 잘못된 새 Secret으로 컨테이너가 교체된 뒤에는 이전 설정으로 자동 복구할 수 없습니다. Secret을 수정해 다시 배포해야 합니다. Docker 재시작 정책에 따른 기존 컨테이너 재시작에는 파일이 필요하지 않지만, 수동 Compose 재생성에는 Secret을 다시 전달해야 합니다. `POSTGRES_PASSWORD`는 기존 DB 계정 비밀번호를 자동으로 바꾸지 않으므로 회전할 때는 위의 `\password da_moa` 절차도 필요합니다. `.minio.env`와 `minio.license`는 서버에 계속 보관합니다. 또한 실행 중인 컨테이너의 환경변수는 Docker 권한으로 조회할 수 있어, 파일 삭제만으로 인스턴스 침해 시 비밀값 노출을 막을 수는 없습니다. [GitHub Environment Secret 설정](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

MinIO 컨테이너와 비공개 버킷·앱 전용 키를 먼저 준비한 뒤 변경 사항을 `main`에 반영하면 CI가 자동으로 배포합니다. 처음에는 **Actions → CI → Run workflow → main**으로도 실행할 수 있습니다. 완료 후 `https://161.33.3.222/api/docs`와 실제 카카오 로그인·영수증 업로드·조회·삭제·정산 흐름을 확인합니다. 서버에서 상태와 로그는 다음 명령으로 확인합니다.

```bash
docker ps --filter name=da-moa-
docker logs --tail=100 da-moa-app-1
docker logs --tail=100 da-moa-postgres-1
docker logs --tail=100 da-moa-minio-1
docker volume ls --filter name=da-moa_
readlink -f /srv/da-moa/current
```

배포 실패 시 Actions 로그를 확인합니다. 빌드나 DB 스키마 생성 실패는 현재 앱을 유지합니다. 전환 직후 점검 실패는 이전 앱 이미지로 복귀를 시도하지만 새 환경값을 사용하므로 잘못된 Secret은 수정 후 재배포해야 합니다. 서버 용량이 부족해지면 현재 및 복구에 필요한 앱 이미지와 릴리스를 제외한 오래된 항목을 삭제합니다.

첫 배포에서 `curl: (52) Empty reply from server`가 나왔다면 앱 시작 중 연결이 끊겼거나 앱이 재시작 중일 수 있습니다. 서버에서 `sudo docker logs --tail=100 da-moa-app-1`, `sudo docker ps -a --filter name=da-moa-app-1`, `curl -i --max-time 5 http://127.0.0.1:3000/api/openapi.json`을 확인합니다. 배포 스크립트는 일시적인 빈 응답도 최대 2분 동안 재시도합니다. `current` 심볼릭 링크가 없는 첫 배포 실패에서는 위의 컨테이너 명령으로 확인합니다.
