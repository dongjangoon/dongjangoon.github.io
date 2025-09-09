---
layout: post
title: "Harbor로 k8s에 Private Registry 구축하기"
date: 2025-05-25 08:48:00 +0000
categories: [kubernetes]
tags: [tech, kubernetes, k8s]
excerpt: "Harbor는 메타데이터를 PostgreSQL DB에, 실제 이미지 레이어를 파일시스템(Registry storage)에 저장"
notion_id: 1feeef64-a1ca-801b-984a-d8980bdd7a2f
notion_url: https://www.notion.so/Harbor-k8s-Private-Registry-1feeef64a1ca801b984ad8980bdd7a2f
---

# Harbor

# Trouble Shooting

## **1. Harbor UI에는 이미지가 보이지만 Pod에서 ImagePullError가 발생**

- 실제 API로 조회해봐도 에러가 남
- 처음에는 인증서 문제인줄 알았으나 다른 문제

<!--more-->
### 원인: PV/PVC 변경으로 인한 데이터 불일치

- Harbor는 메타데이터를 PostgreSQL DB에, 실제 이미지 레이어를 파일시스템(Registry storage)에 저장
- PV/PVC가 변경되면서 DB와 실제 스토리지 간 동기화 문제 발생 가능
- 콘솔은 DB 메타데이터를 보여주지만, API는 실제 레지스트리 스토리지를 확인
### 해결

- 새로 이미지를 푸시해서 해결
## 2. GPU 노드에 taint를 걸고 클러스터 재기동할 때 나타나는 에러

- 파드 중 일부가 배치되어 있던 GPU 노드에 `gpu: true=NoSchedule` 이라는 taint를 추가함
- 클러스터를 재기동하며 파드가 다시 스케줄링 될 때 기존에 gpu 노드에 있던 파드들이 `worker1` 로 옮겨져야 함
- 하지만 worker1에도 `volume node affinity conflict` 라는 에러가 발생해서 새로운 pod가 pending 상태임
### 원인

- 해당 에러를 검색해보면, PV가 특정 노드에 바인딩되어 있는데 해당 노드를 사용하지 못하거나 제약이 있을 때 발생한다고 함
- 즉, 새롭게 배포되는 `jobservice, registry` 의 PV가 `worker2-gpu` 에 배치되고 현재 기존 파드에 바인딩 되어 있어서 `worker1` 노드에 배포되는 파드들은 `pending` 상태가 됨
- 이전에 Harbor를 설치할 때 `worker2-gpu` 노드에 파드가 스케줄링되었음
- `local-path` StorageClass는 파드가 처음 생성된 노드에 PV를 생성하고 해당 노드에 affinity를 설정
- 클러스터 재시작 후 새로운 파드들이 생성되려고 하지만, PV는 여전히 `worker2-gpu`에 바인딩되어 있음
- `worker2-gpu`에는 taint가 있어서 Harbor 파드들이 스케줄링될 수 없음
### 해결

- `local-path` StorageClass를 사용하는 PV의 경우, nodeAffinity만 변경하면 실제 데이터가 있는 디렉토리와 맞지 않아서 문제가 발생함
- 따라서 다음과 같은 과정을 통해 데이터 백업을 진행하고 harbor를 재설치해야 함
### 1단계: Harbor 데이터 백업

```shell
# Database 백업
kubectl exec -it harbor-database-0 -n harbor -- pg_dump -U postgres registry > harbor-db-backup.sq

# Registry 데이터 백업 (실제 이미지들)
kubectl exec -it harbor-registry-6fc475868b-dcvpl -n harbor -c registry -- tar -czf /tmp/registry-backup.tar.gz /storage/docker/registry/

# 백업 파일 로컬로 복사
kubectl cp harbor/harbor-registry-6fc475868b-dcvpl:/tmp/registry-backup.tar.gz ./registry-backup.tar.gz -c registry
```

### 2단계: Harbor 완전 제거

```shell
# Harbor 제거
helm uninstall harbor -n harbor

# PVC 모두 삭제
kubectl delete pvc --all -n harbor

# PV 확인 및 삭제 (자동 삭제되지 않은 경우)
kubectl get pv | grep harbor
kubectl delete pv <harbor-관련-pv들
```

### 3단계: Harbor 재설치

```yaml
helm install harbor harbor/harbor -n harbor -f values.yaml
```

### 4단계: 데이터 복원

```shell
# postgres 데이터 모두 제거

# 백업 파일을 직접 파이프로 PostgreSQL에 전송
kubectl exec -i harbor-database-0 -n harbor -- psql -U postgres registry < harbor-db-backup.sql

# Registry 데이터 복원
kubectl cp registry-backup.tar.gz harbor/harbor-registry-xxx:/tmp/ -c registry
kubectl exec -it harbor-registry-xxx -n harbor -c registry -- tar -xzf /tmp/registry-backup.tar.gz -C /
```

### 5단계: Postgre 데이터 확인

**1. PostgreSQL 접속하여 테이블 확인**

```shell
# PostgreSQL에 접속
kubectl exec -it harbor-database-0 -n harbor -- psql -U postgres -d registry

# 테이블 목록 확인
\dt

# 주요 테이블들의 데이터 개수 확인
SELECT COUNT(*) FROM project;
SELECT COUNT(*) FROM repository;
SELECT COUNT(*) FROM artifact;
SELECT COUNT(*) FROM user_table;

# 최근 생성된 프로젝트들 확인
SELECT project_id, name, creation_time FROM project ORDER BY creation_time DESC LIMIT 10;

# PostgreSQL 세션 종료
\q

# 프로젝트 확인
kubectl exec -it harbor-database-0 -n harbor -- psql -U postgres -d registry -c "
SELECT project_id, name, creation_time FROM project ORDER BY creation_time;
"

# 레포지토리 확인
kubectl exec -it harbor-database-0 -n harbor -- psql -U postgres -d registry -c "
SELECT repository_id, name, project_id FROM repository;
"
```

### 6단계: 레지스트리 데이터 확인

```docker
# Registry 스토리지 디렉토리 확인
kubectl exec -n harbor harbor-registry-6c8797fd48-kzckk -c registry -- ls -la /storage/docker/registry/v2/repositories/

# 복원된 파일들 확인
kubectl exec -n harbor harbor-registry-6c8797fd48-kzckk -c registry -- find /storage/docker/registry -type f | head -20
```

## 2. tls: failed to verify certificate: x509: certificate signed by unknown authority

### 원인

- 인증서 에러 발생
- Harbor 레지스트리가 자체 서명된(self-signed) 인증서 또는 공인되지 않은 CA(Certificate Authority)에 의해 서명된 인증서를 사용하고 있기 때문에 발생
- Kubernetes 노드의 `kubelet`이 해당 인증서를 신뢰하지 못해서 이미지 pull을 실패
### 해결

### 1. 인증서 복사

- Kubernetes 클러스터의 모든 노드에 Harbor 레지스트리의 CA 인증서를 신뢰하도록 설정
- Harbor를 배포하면서 생겨난 `ca.crt` 파일을 복사하여 워커 노드의 `/etc/containerd/certs.d/15.165.92.201:30003` 해당 경로에 붙여넣기
- 추가로 시스템 CA 저장소에도 복사
```bash
sudo cp /etc/containerd/certs.d/15.165.92.201:30003/ca.crt /usr/local/share/ca-certificates/harbor_ca.crt
sudo chmod 644 /usr/local/share/ca-certificates/harbor_ca.crt
sudo update-ca-certificates
```

### 2. containerd 설정 확인하기

- `/etc/containerd/config.toml` 에 설정 필요
```bash
[plugins."io.containerd.cri.v1.images".registry]
    config_path = "/etc/containerd/certs.d"
```

- 위 설정이 없으면 안됨
### 3. containerd, kubelet 재시작

```bash
sudo systemctl daemon-reload
sudo systemctl restart containerd
sudo systemctl restart kubelet

# 이후 Pod 삭제 후 재배포
```

# Local-path-storage 구성하기

- storageclass를 local path로 동적으로 구성하는 방식
```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
```


---

*Originally published in [Notion](https://www.notion.so/Harbor-k8s-Private-Registry-1feeef64a1ca801b984ad8980bdd7a2f) on May 25, 2025*