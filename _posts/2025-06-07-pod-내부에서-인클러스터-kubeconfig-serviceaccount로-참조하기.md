---
layout: post
title: "Pod 내부에서 인클러스터 kubeConfig ServiceAccount로 참조하기"
date: 2025-06-07 08:57:00 +0000
categories: [tech]
tags: [tech]
excerpt: "templates/k8s-mcp-server-rbac.yaml: ServiceAccount 정의에 automountServiceAccountToken: true를 추가하여 Kubernetes 1.24+ 환경에서 서비스 어카운트 토큰이 파드에 자동으로 마운트되도록"
notion_id: 20beef64-a1ca-8065-8492-ebd9676acee8
notion_url: https://www.notion.so/Pod-kubeConfig-ServiceAccount-20beef64a1ca80658492ebd9676acee8
---

- `**templates/k8s-mcp-server-rbac.yaml**`: `ServiceAccount` 정의에 `automountServiceAccountToken: true`를 추가하여 Kubernetes 1.24+ 환경에서 서비스 어카운트 토큰이 파드에 자동으로 마운트되도록 합니다.
- **클러스터 Metrics Server 설치 확인**: `kubectl get apiservice v1beta1.metrics.k8s.io`를 실행하여 Metrics Server가 설치되어 있는지 확인합니다. 설치되어 있지 않다면, 클러스터에 Metrics Server를 배포합니다.

<!--more-->
- `**templates/k8s-mcp-server-deployment.yaml**`: `k8s-mcp-server` 컨테이너의 `env` 섹션에서 `KUBECONFIG_PATH`, `USE_INCLUSTER_CONFIG`, `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT`와 같은 환경 변수를 **제거합니다.** `kubernetes-client` 라이브러리가 ServiceAccount의 정보를 자동으로 감지하도록 하는 것이 좋습니다.
- `**main.py**`: `KubernetesMCPServer` 인스턴스화 시 `kubeconfig_path=None`을 명시적으로 전달하도록 수정하여 인클러스터 설정을 우선하도록 합니다.

---