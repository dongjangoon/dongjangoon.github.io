---
layout: single
title: "스토리지와 RAID 아키텍처"
date: 2025-03-29 14:40:00 +0000
categories: [infrastructure]
tags: [storage, raid, lvm, linux]
excerpt: "RAID 구성과 LVM을 활용한 스토리지 아키텍처 설계 방법을 알아봅니다."
---

## 스토리지 기본 개념

Linux에서 스토리지를 효율적으로 관리하기 위해 LVM(Logical Volume Manager)을 사용합니다. LVM의 계층 구조를 이해하면 유연한 스토리지 관리가 가능합니다.

<!--more-->

### PD (Physical Disk)

실제 물리 저장 장치입니다.
- 하드 디스크 (HDD)
- 솔리드 스테이트 드라이브 (SSD)
- NVMe 드라이브

### PV (Physical Volume)

물리적 디스크를 LVM에서 사용할 수 있도록 초기화한 것입니다.
- 디스크 전체 또는 파티션에 PV 설정 가능
- LVM의 가장 기본 단위

### VG (Volume Group)

하나 이상의 PV를 모아서 만든 스토리지 풀입니다.
- 논리적 볼륨을 할당할 수 있는 공간 제공
- 여러 물리 디스크를 하나의 논리적 저장소로 통합

### LV (Logical Volume)

볼륨 그룹에서 할당된 공간입니다.
- 파일시스템을 마운트하고 실제로 사용하는 단위
- 원하는 만큼 크기 조절 가능
- 경로 예시: `/dev/vg_name/lv_name`

### 관계 흐름

```
PD (물리 디스크)
  ↓
PV (물리 볼륨)
  ↓
VG (볼륨 그룹)
  ↓
LV (논리 볼륨)
  ↓
파일시스템 (ext4, xfs 등)
```

---

## LVM 명령어

### 1. 물리 디스크 확인

```bash
# 블록 디바이스 목록 조회
lsblk

# 디스크 파티션 정보 확인
fdisk -l
```

### 2. 물리 볼륨(PV) 생성

```bash
# PV 생성
pvcreate /dev/sdb

# PV 정보 확인
pvdisplay
pvscan
```

### 3. 볼륨 그룹(VG) 생성

```bash
# VG 생성
vgcreate vg_data /dev/sdb

# 추가 PV를 VG에 포함
vgextend vg_data /dev/sdc

# VG 정보 확인
vgdisplay
vgscan
```

### 4. 논리적 볼륨(LV) 생성

```bash
# 10GB 크기의 LV 생성
lvcreate -n lv_app -L 10G vg_data

# VG의 남은 공간 전체 사용
lvcreate -n lv_app -l 100%FREE vg_data

# LV 정보 확인
lvdisplay
lvscan
```

### 5. 파일시스템 생성 및 마운트

```bash
# ext4 파일시스템 생성
mkfs.ext4 /dev/vg_data/lv_app

# 마운트 포인트 생성 및 마운트
mkdir -p /mnt/app
mount /dev/vg_data/lv_app /mnt/app

# 마운트 확인
df -h
```

### LVM의 장점

| 기능 | 설명 |
|------|------|
| 동적 크기 조절 | LV의 크기를 필요에 따라 확장/축소 가능 |
| 통합 관리 | 여러 PD를 하나의 논리적 공간으로 관리 |
| 스냅샷 | LV의 특정 시점 스냅샷 생성 가능 |
| 스트라이핑/미러링 | 데이터 성능/안정성을 위한 옵션 제공 |

---

## 파일시스템과 마운트

### 파일시스템

저장 장치에 데이터를 저장하고 관리하는 방법을 정의하는 구조입니다.

| 파일시스템 | 특징 |
|-----------|------|
| ext4 | Linux 표준, 저널링 지원 |
| xfs | 대용량 파일 처리에 최적화 |
| btrfs | 스냅샷, 압축 등 고급 기능 |
| zfs | 데이터 무결성, RAID 기능 내장 |

### 마운트

파일시스템을 운영체제의 디렉토리 트리에 연결하는 과정입니다.

### 임시 마운트 vs 영구 마운트

**임시 마운트**
```bash
mount /dev/vg_data/lv_app /mnt/app
# 시스템 재부팅 시 마운트 해제됨
```

**영구 마운트** (`/etc/fstab` 설정)
```bash
# /etc/fstab에 추가
/dev/vg_data/lv_app  /mnt/app  ext4  defaults  0  2
```

### 마운트를 사용하는 이유

1. **일관된 디렉토리 구조 유지**: 물리적 위치와 무관하게 논리적 경로 제공
2. **보안 및 접근 제어**: 마운트 옵션으로 읽기 전용, noexec 등 설정 가능
3. **다양한 파일시스템 지원**: 다른 형식의 파일시스템도 동일하게 접근
4. **동적 관리**: 런타임에 스토리지 추가/제거 가능

---

## RAID (Redundant Array of Independent Disks)

여러 개의 물리적 디스크를 하나의 논리적 디스크처럼 사용하는 기술입니다.

### RAID 레벨 비교

| 레벨 | 방식 | 최소 디스크 | 용량 효율 | 내결함성 | 성능 |
|------|------|-----------|----------|---------|------|
| RAID 0 | 스트라이핑 | 2 | 100% | 없음 | 높음 |
| RAID 1 | 미러링 | 2 | 50% | 1개 장애 허용 | 읽기 향상 |
| RAID 5 | 스트라이핑 + 패리티 | 3 | (n-1)/n | 1개 장애 허용 | 중간 |
| RAID 6 | 이중 패리티 | 4 | (n-2)/n | 2개 장애 허용 | 중간 |
| RAID 10 | 미러링 + 스트라이핑 | 4 | 50% | 각 미러당 1개 | 높음 |

### RAID 0 (Striping)

```
┌─────────┐ ┌─────────┐
│ Disk 1  │ │ Disk 2  │
├─────────┤ ├─────────┤
│ Block 1 │ │ Block 2 │
│ Block 3 │ │ Block 4 │
│ Block 5 │ │ Block 6 │
└─────────┘ └─────────┘
```
- 데이터를 여러 디스크에 분산 저장
- 성능 향상, 중복성 없음

### RAID 1 (Mirroring)

```
┌─────────┐ ┌─────────┐
│ Disk 1  │ │ Disk 2  │
├─────────┤ ├─────────┤
│ Block 1 │ │ Block 1 │
│ Block 2 │ │ Block 2 │
│ Block 3 │ │ Block 3 │
└─────────┘ └─────────┘
```
- 동일 데이터를 복제 저장
- 데이터 보호, 용량 50%

### RAID 5 (Striping + Parity)

```
┌─────────┐ ┌─────────┐ ┌─────────┐
│ Disk 1  │ │ Disk 2  │ │ Disk 3  │
├─────────┤ ├─────────┤ ├─────────┤
│ Block 1 │ │ Block 2 │ │ Parity  │
│ Block 3 │ │ Parity  │ │ Block 4 │
│ Parity  │ │ Block 5 │ │ Block 6 │
└─────────┘ └─────────┘ └─────────┘
```
- 패리티를 분산 저장
- 1개 디스크 장애 시 복구 가능

---

## LVM에서 Striping과 Mirroring

### Striping 설정

```bash
# 2개 디스크에 스트라이핑, 스트라이프 크기 64KB
lvcreate -n striped_lv -L 10G -i 2 -I 64 vg_data
```

| 옵션 | 설명 |
|------|------|
| `-i 2` | 2개의 디스크에 스트라이핑 |
| `-I 64` | 스트라이프 크기 64KB |

**장점**
- 여러 디스크에 동시 I/O로 성능 향상
- 병렬 처리로 대역폭 증가

**단점**
- 하나의 디스크 고장 시 전체 데이터 손실
- 단독으로는 복구 불가능

### Mirroring 설정

```bash
# 미러 사본 1개 생성 (총 2개의 복사본)
lvcreate -n mirrored_lv -L 10G -m 1 vg_data
```

| 옵션 | 설명 |
|------|------|
| `-m 1` | 미러 사본 1개 생성 |

**장점**
- 디스크 장애 시에도 데이터 보존
- 읽기 성능 향상 가능

**단점**
- 저장 공간 50% 효율
- 쓰기 시 양쪽에 기록해야 하므로 쓰기 성능 저하
