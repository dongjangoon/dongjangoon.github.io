---
layout: post
title: "Kubernetes 운영 최적화: 스토리지, NTP 동기화, 헬스 프로브 설정"
date: 2025-09-10 14:00:00 +0000
categories: [kubernetes, operations, monitoring]
tags: [storage, ntp, health-probe, storageclass, liveness, readiness, startup-probe]
excerpt: "Kubernetes 클러스터의 안정적 운영을 위한 스토리지 설정, 시간 동기화, 헬스 프로브 최적화 가이드"
---

# Kubernetes 운영 최적화: 스토리지, NTP 동기화, 헬스 프로브 설정

프로덕션 Kubernetes 클러스터를 안정적으로 운영하기 위해서는 스토리지 설정, 노드 간 시간 동기화, 애플리케이션 헬스 체크 등의 기본 인프라를 제대로 구성해야 합니다. 이번 글에서는 이러한 운영 최적화 요소들을 실무 관점에서 살펴보겠습니다.

## 스토리지 클래스 설정과 데이터 보존 정책

### 스토리지 클래스는 언제 Retain vs Delete를 사용할까?

프로덕션 환경에서는 데이터 손실 위험을 고려해 `Retain` 정책을 기본으로 하되, 개발/테스트 환경에서는 비용 절약을 위해 `Delete`를 사용합니다.

**NAS 기반 스토리지 클래스 (데이터 보존)**
```yaml
# NAS Retain - 프로덕션 환경용
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-retain-sc
parameters:
  server: 192.168.1.100  # NAS IP
  share: /nfs/production  # NAS Path
provisioner: nfs.csi.k8s.io
reclaimPolicy: Retain
volumeBindingMode: Immediate
```

**클라우드 오브젝트 스토리지 연동**
```yaml
# S3 호환 오브젝트 스토리지 연동
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: s3-storage-sc
provisioner: ch.ctrox.csi.s3-driver
parameters:
  mounter: rclone
  bucket: "my-k8s-storage"
  region: "ap-northeast-2"
  endpoint: "https://s3.ap-northeast-2.amazonaws.com"
```

### Retain된 PV 삭제 시 아카이브 처리는?

일부 스토리지 프로비저너에서는 `archiveOnDelete` 또는 `archived` 파라미터를 통해 PV 삭제 시 물리적 삭제 대신 아카이브 처리를 할 수 있습니다.

**NFS CSI Driver 아카이브 설정**
```yaml
# 삭제 시 아카이브 폴더로 이동
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-archive-sc
provisioner: nfs.csi.k8s.io
parameters:
  server: 192.168.1.100
  share: /nfs/production
  archiveOnDelete: "true"  # PV 삭제 시 아카이브 처리
reclaimPolicy: Retain
```

이 설정을 사용하면 PV를 수동으로 삭제해도 실제 데이터는 아카이브 디렉토리로 이동되어 완전 삭제를 방지합니다. 데이터 복구가 필요한 상황에 유용합니다.

### volumeBindingMode를 Immediate로 설정하는 이유는?

`volumeBindingMode: Immediate`는 PVC가 생성되는 즉시 볼륨을 바인딩합니다. NAS나 오브젝트 스토리지처럼 노드 위치에 상관없이 접근 가능한 스토리지의 경우, 빠른 바인딩이 가능하므로 이 설정을 사용합니다. 반면 로컬 스토리지나 특정 가용영역의 EBS는 `WaitForFirstConsumer`를 사용해 Pod 스케줄링 후 바인딩합니다.

## 클러스터 시간 동기화 (NTP) 설정

### 노드 간 시간 차이가 발생하면 어떤 문제가 생길까?

Kubernetes는 etcd를 통해 상태를 관리하는데, 노드 간 시간 차이가 크면 lease 갱신, 로그 타임스탬프, 인증서 유효성 검증 등에서 문제가 발생할 수 있습니다.

**노드별 시간 확인**
```bash
# 모든 노드의 heartbeat 시간 확인
kubectl get nodes -o custom-columns=NAME:.metadata.name,TIME:.status.conditions[0].lastHeartbeatTime
```

**Ubuntu 노드 시간 동기화 설정**
```bash
# chrony 설치 및 AWS NTP 서버 설정
sudo apt-get update && sudo apt-get install -y chrony

# AWS 전용 NTP 서버 (권장)
sudo tee -a /etc/chrony/chrony.conf > /dev/null << 'EOF'
pool 0.amazon.pool.ntp.org iburst
pool 1.amazon.pool.ntp.org iburst
pool 2.amazon.pool.ntp.org iburst
pool 3.amazon.pool.ntp.org iburst

# 한국 공용 NTP 서버 (백업)
pool kr.pool.ntp.org iburst
EOF

sudo systemctl restart chrony
sudo systemctl enable chrony

# 동기화 소스 및 상태 확인
chronyc sources
chronyc tracking
```

**Amazon Linux 2023 설정**
```bash
# chrony 설정 최적화
sudo tee /etc/chrony.conf > /dev/null << 'EOF'
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync

pool 0.amazon.pool.ntp.org iburst
pool 1.amazon.pool.ntp.org iburst
pool 2.amazon.pool.ntp.org iburst
pool 3.amazon.pool.ntp.org iburst
EOF

sudo systemctl enable chronyd
sudo systemctl restart chronyd

# 동기화 상태 검증
sudo chronyc tracking
sudo chronyc sources -v
```

## 헬스 프로브 최적화 설정

### Startup, Liveness, Readiness 프로브를 모두 설정하는 이유는?

각 프로브는 서로 다른 역할을 담당합니다:
- **Startup**: 초기 부팅이 오래 걸리는 애플리케이션의 시작 완료 확인
- **Liveness**: 애플리케이션 데드락이나 무한루프 등의 문제로 재시작이 필요한지 확인  
- **Readiness**: 트래픽을 받을 준비가 되었는지 확인 (로드밸런서 라우팅 제어)

**종합적인 헬스 프로브 설정**
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app-pod
  labels:
    app: my-app
spec:
  containers:
  - name: my-app-container
    image: my-app-image:latest
    ports:
    - name: management
      containerPort: 8081
    
    # Startup Probe: 초기 시작 시간이 오래 걸리는 애플리케이션용
    startupProbe:
      httpGet:
        path: /health/startup
        port: management
        scheme: HTTP
      initialDelaySeconds: 10      # 첫 검사까지 대기 시간
      periodSeconds: 5             # 검사 간격 (5초마다)
      timeoutSeconds: 3            # 응답 대기 시간
      successThreshold: 1          # 성공으로 간주할 연속 성공 횟수
      failureThreshold: 30         # 실패로 간주할 연속 실패 횟수 (5초 * 30 = 150초)
      
    # Liveness Probe: 애플리케이션이 살아있는지 확인
    livenessProbe:
      httpGet:
        path: /health/live
        port: management
        scheme: HTTP
      initialDelaySeconds: 30      # startup probe 완료 후 시작
      periodSeconds: 10            # 10초마다 검사
      timeoutSeconds: 5            # 5초 내 응답 필요
      successThreshold: 1          # 1번 성공하면 정상
      failureThreshold: 3          # 3번 연속 실패하면 재시작
    
    # Readiness Probe: 트래픽을 받을 준비가 되었는지 확인
    readinessProbe:
      httpGet:
        path: /health/ready
        port: management
        scheme: HTTP
      initialDelaySeconds: 5       # 빠른 시작
      periodSeconds: 5             # 5초마다 검사 (더 자주)
      timeoutSeconds: 3            # 3초 내 응답
      successThreshold: 1          # 1번 성공하면 준비 완료
      failureThreshold: 3          # 3번 실패하면 트래픽 차단
```

### failureThreshold를 너무 낮게 설정하면 안 되는 이유는?

네트워크 지연이나 일시적인 부하로 인한 응답 지연을 실제 장애로 오인할 수 있습니다. 특히 Liveness Probe의 경우 잘못된 재시작을 방지하기 위해 충분한 여유를 두는 것이 중요합니다.

### Readiness Probe가 실패하면 어떻게 될까?

Readiness Probe 실패 시 해당 Pod는 Service의 endpoint에서 제외되어 트래픽을 받지 않게 됩니다. 하지만 Pod 자체는 재시작되지 않으므로, 일시적인 문제 해결 후 다시 트래픽을 받을 수 있습니다.

## 운영 체크리스트

### 스토리지 운영 점검사항
- [ ] PVC Retain 정책이 프로덕션 데이터에 적용되었는지 확인
- [ ] 오브젝트 스토리지 백업 정책 설정 확인
- [ ] 스토리지 용량 모니터링 및 알람 설정

### 시간 동기화 점검사항  
- [ ] 모든 노드의 NTP 동기화 상태 정상 확인
- [ ] chrony 서비스 자동 시작 설정 확인
- [ ] 시간 편차 모니터링 설정

### 헬스 프로브 점검사항
- [ ] 각 애플리케이션별 적절한 프로브 timeout 설정
- [ ] Startup probe failureThreshold가 실제 부팅 시간을 고려했는지 확인  
- [ ] Liveness probe가 너무 민감하게 설정되지 않았는지 검토
- [ ] Readiness probe endpoint가 실제 서비스 준비 상태를 반영하는지 확인

이러한 기본 인프라 설정을 통해 Kubernetes 클러스터의 안정성과 가용성을 크게 향상시킬 수 있습니다.