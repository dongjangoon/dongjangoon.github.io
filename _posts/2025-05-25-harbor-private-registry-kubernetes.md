---
layout: single
title: "Harbor로 Kubernetes Private Registry 구축하기"
date: 2025-05-25 08:48:00 +0000
last_modified_at: 2026-02-17
categories: [kubernetes]
tags: [harbor, registry, kubernetes, container]
excerpt: "Harbor를 사용하여 Kubernetes 클러스터에 Private Container Registry를 구축하고 운영하는 방법과 트러블슈팅 가이드를 다룹니다."
---

## Harbor 소개

Harbor는 오픈소스 컨테이너 이미지 레지스트리로, 보안, 정책 관리, RBAC 등 엔터프라이즈급 기능을 제공합니다. Kubernetes 환경에서 Private Registry로 많이 사용됩니다.

<!--more-->

### Harbor 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                      Harbor                             │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   Portal    │  │   Core API  │  │  Job Service    │ │
│  │   (UI)      │  │   (REST)    │  │  (Async Tasks)  │ │
│  └─────────────┘  └─────────────┘  └─────────────────┘ │
│                         │                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                   PostgreSQL                        │ │
│  │              (메타데이터 저장)                        │ │
│  └─────────────────────────────────────────────────────┘ │
│                         │                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Registry Storage                       │ │
│  │           (실제 이미지 레이어)                        │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**핵심 포인트**
- 메타데이터는 PostgreSQL DB에 저장
- 실제 이미지 레이어는 파일시스템(Registry storage)에 저장
- UI 콘솔은 DB 메타데이터를 표시하고, API는 실제 스토리지를 확인

---

## Trouble Shooting

### 1. Harbor UI에는 이미지가 보이지만 Pod에서 ImagePullError 발생

**증상**
- Harbor 콘솔에서는 이미지가 보임
- `kubectl`로 Pod 배포 시 `ImagePullError` 발생
- API로 조회해도 에러 발생

**원인: PV/PVC 변경으로 인한 데이터 불일치**

Harbor는 메타데이터와 실제 이미지 레이어를 분리 저장합니다.
- PV/PVC가 변경되면서 DB와 실제 스토리지 간 동기화 문제 발생
- 콘솔(DB 메타데이터)과 API(실제 스토리지) 간 불일치

**해결 방법**
- 이미지를 다시 push하여 동기화

---

### 2. GPU 노드 Taint 후 Volume Node Affinity Conflict

**증상**
- GPU 노드에 `gpu=true:NoSchedule` taint 추가
- 클러스터 재기동 시 Harbor Pod들이 `Pending` 상태
- `volume node affinity conflict` 에러 발생

**원인 분석**

`local-path` StorageClass는 Pod가 처음 생성된 노드에 PV를 생성하고 해당 노드에 affinity를 설정합니다.

```
┌─────────────────────────────────────────────────────┐
│  최초 배포 시                                        │
│  Harbor Pod → worker2-gpu에 스케줄링                 │
│  PV → worker2-gpu에 생성 및 바인딩                   │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│  Taint 추가 후 재시작                                │
│  새 Pod → worker2-gpu에 스케줄링 불가 (Taint)        │
│  새 Pod → worker1에도 배치 불가 (PV가 worker2-gpu)   │
│  결과: Pending 상태                                  │
└─────────────────────────────────────────────────────┘
```

**해결: Harbor 데이터 백업 및 재설치**

`local-path` StorageClass의 경우 nodeAffinity만 변경하면 실제 데이터 디렉토리와 맞지 않아 문제가 발생합니다. 따라서 백업 후 재설치가 필요합니다.

#### Step 1: Harbor 데이터 백업

```bash
# Database 백업
kubectl exec -it harbor-database-0 -n harbor -- \
  pg_dump -U postgres registry > harbor-db-backup.sql

# Registry 데이터 백업 (실제 이미지들)
kubectl exec -it harbor-registry-xxx -n harbor -c registry -- \
  tar -czf /tmp/registry-backup.tar.gz /storage/docker/registry/

# 백업 파일 로컬로 복사
kubectl cp harbor/harbor-registry-xxx:/tmp/registry-backup.tar.gz \
  ./registry-backup.tar.gz -c registry
```

#### Step 2: Harbor 완전 제거

```bash
# Harbor 제거
helm uninstall harbor -n harbor

# PVC 모두 삭제
kubectl delete pvc --all -n harbor

# PV 확인 및 삭제
kubectl get pv | grep harbor
kubectl delete pv <harbor-관련-pv들>
```

#### Step 3: Harbor 재설치

```bash
helm install harbor harbor/harbor -n harbor -f values.yaml
```

#### Step 4: 데이터 복원

```bash
# PostgreSQL 데이터 복원
kubectl exec -i harbor-database-0 -n harbor -- \
  psql -U postgres registry < harbor-db-backup.sql

# Registry 데이터 복원
kubectl cp registry-backup.tar.gz harbor/harbor-registry-xxx:/tmp/ -c registry
kubectl exec -it harbor-registry-xxx -n harbor -c registry -- \
  tar -xzf /tmp/registry-backup.tar.gz -C /
```

#### Step 5: 데이터 검증

```bash
# PostgreSQL 테이블 확인
kubectl exec -it harbor-database-0 -n harbor -- \
  psql -U postgres -d registry -c "SELECT COUNT(*) FROM repository;"

# Registry 스토리지 확인
kubectl exec -n harbor harbor-registry-xxx -c registry -- \
  ls -la /storage/docker/registry/v2/repositories/
```

---

### 3. TLS 인증서 오류 (x509: certificate signed by unknown authority)

**증상**
```
tls: failed to verify certificate: x509: certificate signed by unknown authority
```

**원인**

Harbor가 자체 서명된(self-signed) 인증서를 사용하고 있어서 Kubernetes 노드의 kubelet이 해당 인증서를 신뢰하지 못합니다.

**해결 방법**

#### 1. 인증서를 모든 노드에 복사

```bash
# Harbor CA 인증서를 containerd 인증서 디렉토리에 복사
sudo mkdir -p /etc/containerd/certs.d/<harbor-domain>:<port>
sudo cp ca.crt /etc/containerd/certs.d/<harbor-domain>:<port>/

# 시스템 CA 저장소에도 복사
sudo cp ca.crt /usr/local/share/ca-certificates/harbor_ca.crt
sudo chmod 644 /usr/local/share/ca-certificates/harbor_ca.crt
sudo update-ca-certificates
```

#### 2. containerd 설정 확인

`/etc/containerd/config.toml`에 다음 설정이 필요합니다.

```toml
[plugins."io.containerd.cri.v1.images".registry]
    config_path = "/etc/containerd/certs.d"
```

#### 3. 서비스 재시작

```bash
sudo systemctl daemon-reload
sudo systemctl restart containerd
sudo systemctl restart kubelet

# Pod 재배포
kubectl delete pod <pod-name> -n <namespace>
```

---

## Local-path-storage 구성

동적 PV 프로비저닝을 위한 StorageClass입니다.

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
```

**주의사항**
- `local-path`는 노드 로컬 스토리지를 사용하므로 Pod가 다른 노드로 재스케줄링되면 데이터 접근 불가
- 프로덕션 환경에서는 네트워크 스토리지(EBS, NFS 등) 권장
