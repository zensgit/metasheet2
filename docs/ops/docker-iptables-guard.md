# Docker iptables guard

## Why
Occasionally Docker can fail to recreate containers with:
```
failed to set up container networking ... iptables: No chain/target/match by that name
```

To prevent this, we install a small oneshot service that ensures the `DOCKER` iptables chain exists **before** `docker.service` starts.

## Files
- `/usr/local/bin/docker-iptables-ensure`
- `/etc/systemd/system/docker-iptables-ensure.service`

## Install (server)
```
sudo mkdir -p /usr/local/bin
sudo tee /usr/local/bin/docker-iptables-ensure > /dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if ! iptables -nL DOCKER >/dev/null 2>&1; then
  iptables -N DOCKER
fi
EOF

sudo chmod +x /usr/local/bin/docker-iptables-ensure

sudo tee /etc/systemd/system/docker-iptables-ensure.service > /dev/null <<'EOF'
[Unit]
Description=Ensure Docker iptables chain exists
After=network.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/docker-iptables-ensure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable docker-iptables-ensure.service
sudo systemctl start docker-iptables-ensure.service
```

## Verify
```
sudo systemctl status docker-iptables-ensure.service --no-pager
sudo iptables -S DOCKER
```
