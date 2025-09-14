---
layout: post
title: "k3d 클러스터와 Ingress-Nginx로 로컬 개발 환경 구축하기 [Claude Code 오픈소스 기여 도전기 #2]"
date: 2025-09-14 13:45:00 +0900
categories: [Kubernetes, Development]
tags: [k3d, ingress-nginx, kubernetes, claude-code, agent-os, alloy-kafka]
excerpt: "WSL2 환경에서 k3d 클러스터 생성과 ingress-nginx 설치를 통한 로컬 Kubernetes 개발 환경 구축 과정을 상세히 다룹니다."
---

## 들어가며

[1편]({% post_url 2025-09-13-agent-os-claude-code-opensource-contribution-1 %})에서 Agent-OS를 통해 Alloy-Kafka 개발 환경 구축을 시작했습니다. 이번 글에서는 외부 접근이 가능한 완전한 로컬 개발 환경을 구축하는 과정을 다루겠습니다.

### 환경 정보
- **OS**: Windows 11 + WSL2
- **WSL Distribution**: AlmaLinux 9
- **Container Runtime**: Docker
- **Kubernetes**: k3d (k3s 기반)

## k3d 클러스터 현재 상태 점검

먼저 기존에 생성된 클러스터의 상태를 확인해보겠습니다.

```bash
# 현재 클러스터 컨텍스트 확인
kubectl config current-context
# k3d-alloy-kafka-dev

# 클러스터 노드 상태
kubectl get nodes
# NAME                           STATUS   ROLES                  AGE   VERSION
# k3d-alloy-kafka-dev-server-0   Ready    control-plane,master   17h   v1.31.5+k3s1

# 전체 파드 상태 확인
kubectl get pods --all-namespaces
```

기존 클러스터에는 이미 다음 컴포넌트들이 배포되어 있었습니다:

- **Kafka**: `kafka` 네임스페이스에 단일 노드 클러스터
- **Alloy**: `default` 네임스페이스에 로그 수집기
- **Monitoring Stack**: `monitoring` 네임스페이스에 Prometheus, Grafana, Loki

하지만 외부에서 대시보드에 접근할 수 없는 상황이었습니다.

## 문제점 분석: 외부 접근의 한계

k3d 클러스터는 기본적으로 Docker 컨테이너 내부에서 실행되므로, 서비스에 외부에서 직접 접근하기 어렵습니다. 특히 WSL 환경에서는 다음과 같은 네트워크 계층을 거쳐야 합니다:

```
Windows 브라우저 → WSL2 → Docker → k3d 클러스터 → Kubernetes 서비스
```

k3d는 기본적으로 Traefik 로드밸런서를 8080 포트로 제공하지만, 더 유연한 라우팅을 위해 ingress-nginx를 추가로 설치하기로 결정했습니다.

## Ingress-Nginx Controller 설치

### Helm 리포지토리 설정

```bash
# ingress-nginx 헬름 리포지토리 추가
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx

# 리포지토리 업데이트
helm repo update
```

### NodePort 방식으로 설치

WSL 환경에서 외부 접근을 위해 NodePort 타입으로 ingress-nginx를 설치했습니다:

```bash
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.type=NodePort \
  --set controller.service.nodePorts.http=30080 \
  --set controller.service.nodePorts.https=30443
```

### 설치 확인

```bash
# 파드 상태 확인
kubectl get pods -n ingress-nginx

# 준비 상태까지 대기
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=ingress-nginx \
  -n ingress-nginx --timeout=300s
```

## 각 서비스별 Ingress 리소스 생성

### 서비스 현황 파악

먼저 현재 배포된 서비스들을 확인했습니다:

```bash
# monitoring 네임스페이스의 서비스
kubectl get svc -n monitoring

# default 네임스페이스의 alloy 서비스  
kubectl get svc -n default | grep alloy
```

주요 서비스들:
- **Grafana**: `prometheus-grafana` (포트 80)
- **Prometheus**: `prometheus-kube-prometheus-prometheus` (포트 9090) 
- **Alloy**: `alloy` (포트 12345)

### Grafana Ingress 생성

```yaml
# grafana-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grafana-ingress
  namespace: monitoring
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: grafana.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: prometheus-grafana
            port:
              number: 80
```

### Prometheus Ingress 생성

```yaml
# prometheus-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: prometheus-ingress
  namespace: monitoring
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: prometheus.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: prometheus-kube-prometheus-prometheus
            port:
              number: 9090
```

### Alloy Ingress 생성

```yaml
# alloy-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: alloy-ingress
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: alloy.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: alloy
            port:
              number: 12345
```

### Ingress 적용 및 확인

```bash
# 모든 ingress 리소스 적용
kubectl apply -f grafana-ingress.yaml
kubectl apply -f prometheus-ingress.yaml  
kubectl apply -f alloy-ingress.yaml

# 상태 확인
kubectl get ingress --all-namespaces
```

```
NAMESPACE    NAME                 CLASS   HOSTS              ADDRESS         PORTS   AGE
default      alloy-ingress        nginx   alloy.local        10.43.164.167   80      5s
monitoring   grafana-ingress      nginx   grafana.local      10.43.164.167   80      37s
monitoring   prometheus-ingress   nginx   prometheus.local   10.43.164.167   80      20s
```

## WSL에서 Windows 브라우저 접근 설정

### 네트워크 구조 이해

WSL2는 독립적인 네트워크 인터페이스를 사용하므로, Windows에서 접근하려면 WSL의 IP 주소를 알아야 합니다:

```bash
# WSL IP 주소 확인
hostname -I
# 192.168.164.143 172.17.0.1 172.18.0.1

# WSL 게이트웨이 확인
ip route show | grep default
# default via 192.168.160.1 dev eth0 proto kernel
```

### NodePort 포트 포워딩

k3d 클러스터가 NodePort 30080을 직접 노출하지 않으므로, 포트 포워딩이 필요합니다:

```bash
# ingress-nginx 포트 포워딩 (백그라운드)
kubectl port-forward -n ingress-nginx \
  svc/ingress-nginx-controller 30080:80 --address 0.0.0.0 &
```

이 명령어는 다음을 수행합니다:
- `--address 0.0.0.0`: 모든 인터페이스에서 연결 허용
- `30080:80`: 로컬 30080 포트를 ingress-nginx의 80 포트로 포워딩
- `&`: 백그라운드에서 실행

### Windows hosts 파일 설정

Windows에서 도메인 접근을 위해 hosts 파일을 수정합니다:

**파일 위치**: `C:\Windows\System32\drivers\etc\hosts`

**관리자 권한으로 메모장을 열고 다음 내용 추가**:
```
192.168.164.143 grafana.local
192.168.164.143 prometheus.local
192.168.164.143 alloy.local
```

### 접근 확인

이제 Windows 브라우저에서 다음 URL로 접근할 수 있습니다:

- **Grafana**: http://grafana.local:30080
- **Prometheus**: http://prometheus.local:30080
- **Alloy**: http://alloy.local:30080

## 포트 포워딩 관리

### 백그라운드 프로세스 확인

```bash
# 백그라운드 작업 확인
jobs

# 포트 포워딩 프로세스를 포그라운드로 가져오기
fg

# 중지 (포그라운드 상태에서)
# Ctrl + C
```

### 포트 사용 확인

```bash
# 포트 30080 사용 중인 프로세스 확인
netstat -tlnp | grep 30080

# sudo 권한으로 자세한 정보 확인
sudo netstat -tlnp | grep 30080
```

## 더 나은 해결책: k3d 클러스터 재구성

현재 포트 포워딩 방식은 임시적인 해결책입니다. 영구적인 해결을 위해서는 k3d 클러스터를 포트 매핑과 함께 재생성하는 것이 좋습니다:

```bash
# 현재 클러스터 삭제 (주의: 모든 데이터 손실)
k3d cluster delete alloy-kafka-dev

# 포트 매핑과 함께 클러스터 재생성
k3d cluster create alloy-kafka-dev \
  --port "30080:30080@server:0" \
  --port "30443:30443@server:0" \
  --port "8080:80@loadbalancer"
```

이렇게 하면 포트 포워딩 없이도 NodePort 서비스에 직접 접근할 수 있습니다.

## 트러블슈팅 팁

### Windows 방화벽 확인

Windows PowerShell에서 방화벽 규칙 확인:
```powershell
Get-NetFirewallRule -DisplayName "*30080*"
```

### WSL 방화벽 확인

```bash
# UFW 상태 확인
sudo ufw status

# 필요시 포트 허용
sudo ufw allow 30080
```

### Docker 포트 매핑 확인

```bash
# k3d 컨테이너의 포트 매핑 확인
docker ps | grep k3d
```

## 마무리

이번 글에서는 k3d 클러스터에 ingress-nginx를 설치하고, WSL 환경에서 Windows 브라우저로 접근할 수 있는 환경을 구축했습니다. 

**핵심 포인트**:
- NodePort 타입의 ingress-nginx 설치
- 각 서비스별 Ingress 리소스 생성
- WSL IP 기반 포트 포워딩 설정
- Windows hosts 파일 수정

**다음 편에서는**:
- 실제 Prometheus, Grafana 대시보드 접근
- Loki 로그 데이터 확인
- Alloy-Kafka 통합 모니터링 구성

모든 설정 파일과 명령어는 [GitHub 리포지토리](https://github.com/dongjangoon/alloy-kafka-dev)에서 확인하실 수 있습니다.

---

*이 시리즈는 Claude Code와 Agent-OS를 활용한 실제 오픈소스 기여 과정을 실시간으로 기록합니다. 모든 과정이 AI와의 협업을 통해 진행되고 있습니다.*