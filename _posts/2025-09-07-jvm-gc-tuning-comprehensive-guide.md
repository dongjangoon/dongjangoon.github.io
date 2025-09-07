---
layout: post
title: "JVM 설정과 GC 튜닝: 실무 가이드"
date: 2025-09-07 13:00:00 +0000
categories: [java, performance]
tags: [jvm, gc, garbage-collection, java-tuning, parallel-gc, g1-gc, cms-gc, memory-management]
excerpt: "Java 애플리케이션 성능 최적화를 위한 JVM 설정과 Garbage Collection 튜닝 실무 가이드. 실제 프로젝트 설정 예시와 함께 살펴봅니다."
---

## 들어가며

Java 애플리케이션의 성능을 좌우하는 가장 중요한 요소 중 하나는 **JVM(Java Virtual Machine) 설정**과 **Garbage Collection(GC) 튜닝**입니다. 

이 글에서는 실제 프로덕션 환경에서 사용되는 JVM 설정 예시를 분석하고, 각 GC 알고리즘의 특성과 선택 기준을 살펴보겠습니다.

## 실제 프로젝트 JVM 설정 분석

### 예시 1: 전통적인 서버 환경 (A 프로젝트)

```bash
#!/bin/bash

export SPRING_BOOT_PROFILE=dev

export JVM_HEAP_SIZE=1024
export JVM_METASPACE_SIZE=512

JVM_OPTS="${JVM_OPTS} -XX:MaxMetaspaceSize=${JVM_METASPACE_SIZE}m"
JVM_OPTS="${JVM_OPTS} -XX:+UseParallelGC"

# GC의 적응형 크기 조정 정책 비활성화
# 힙 영역의 크기를 개발자가 명시적으로 제어
JVM_OPTS="${JVM_OPTS} -XX:-UseAdaptiveSizePolicy"

# 명시적 GC 호출(System.gc())이 발생할 때, Concurrent GC로 수행
JVM_OPTS="${JVM_OPTS} -XX:+ExplicitGCInvokesConcurrent"

# OutOfMemoryError 발생 시 자동으로 힙 덤프 파일 생성
JVM_OPTS="${JVM_OPTS} -XX:+HeapDumpOnOutOfMemoryError"

# GC 로그 (주석 처리됨)
#JVM_OPTS="${JVM_OPTS} -verbose:gc"
#JVM_OPTS="${JVM_OPTS} -XX:+PrintGCDetails"

java $JVM_OPTS -Dspring.profiles.active=${SPRING_BOOT_PROFILE} -jar aapserver.jar
```

**주요 특징:**
- **고정 크기 힙 메모리**: 명확한 메모리 제한
- **Parallel GC**: 높은 처리량이 중요한 배치 작업에 적합
- **개발자 제어**: 적응형 크기 조정 비활성화로 예측 가능한 동작

### 예시 2: 컨테이너 환경 (B 프로젝트)

```bash
#!/bin/sh

# 초기 및 최대 힙 메모리를 컨테이너에 할당된 메모리의 80%로 설정
# 컨테이너 환경 메모리 관리를 위한 방식
JAVA_OPTS="${JAVA_OPTS} -XX:InitialRAMPercentage=80.0 -XX:MaxRAMPercentage=80.0"

# 메타스페이스의 최대 크기를 256MB로 제한
# 클래스 메타데이터의 메모리 누수 방지
JAVA_OPTS="${JAVA_OPTS} -XX:MaxMetaspaceSize=256m"

# 암호화 작업에 사용되는 난수 생성기를 /dev/urandom을 사용하도록 지정
# /dev/random 대신 엔트로피 풀 고갈 시 블로킹 방지
JAVA_OPTS="${JAVA_OPTS} -Djava.security.egd=file:/dev/./urandom"

# Spring Boot의 백그라운드 사전 초기화 기능을 비활성화
JAVA_OPTS="${JAVA_OPTS} -Dspring.backgroundpreinitializer.ignore=true"

# GC 로그를 디버그 레벨로 설정, /var/log/app/gc.log 에 저장
JAVA_OPTS="${JAVA_OPTS} -Xlog:gc*=debug:file=/var/log/app/gc.log:time,level,tags"

exec java ${JAVA_OPTS} -jar /source001/boot.jar
```

**주요 특징:**
- **컨테이너 최적화**: 할당된 메모리의 비율로 힙 크기 설정
- **시작 시간 최적화**: 난수 생성기와 백그라운드 초기화 설정
- **로깅 강화**: 상세한 GC 로그 수집

## Spring Boot 백그라운드 사전 초기화

### 작동 방식

1. **애플리케이션이 시작되면 별도의 백그라운드 스레드를 생성**
2. **이 스레드는 메인 애플리케이션 시작과 병렬로 일부 Spring 컴포넌트 (ex: 유효성 검사기, 메시지 변환기 등)을 미리 초기화함**
3. **메인 애플리케이션이 이러한 컴포넌트들을 필요로 할 때, 이미 초기화된 상태이므로 전체 시작 시간이 단축됨**

### 장점과 단점

**장점:**
- 멀티코어 시스템에서 CPU 사용 최적화
- 전체 애플리케이션 시작 시간 단축

**단점:**
- 일부 환경(리소스 제한)에서는 메모리 사용량이 증가
- 특정 상황에서 스레드 경합이나 데드락 같은 문제 발생 가능

**비활성화 이유:**
컨테이너 환경에서는 안정성과 예측 가능한 동작이 더 중요하므로 비활성화하는 경우가 많습니다.

## Garbage Collection 알고리즘 비교

### 1. Parallel GC (처리량 우선)

**특징:**
- **JDK 8의 기본 GC**
- 여러 스레드를 사용하여 메모리 수집 작업을 병렬로 처리
- **STW(Stop-The-World) 방식**으로 작동, 수집 중 애플리케이션 스레드 모두 중단

**장점:**
- **높은 throughput**: 전체적인 처리량이 뛰어남
- **멀티코어 CPU에서 효율적**: CPU 자원을 최대한 활용
- **메모리 활용도 높음**: 힙 공간을 효율적으로 사용

**단점:**
- **긴 일시 중지 시간**: STW로 인한 응답성 저하

**적용 사례:**
```bash
JVM_OPTS="${JVM_OPTS} -XX:+UseParallelGC"
JVM_OPTS="${JVM_OPTS} -XX:-UseAdaptiveSizePolicy"  # 크기 조정 정책 비활성화
```

### 2. Concurrent Mark Sweep GC (CMS, 응답 시간 우선)

**특징:**
- **대부분의 가비지 수집 작업을 애플리케이션 실행과 동시에 수행**
- JDK 9부터 deprecated, **JDK 14에서 제거됨**

**장점:**
- **짧은 일시 중지 시간**: 응답성이 중요한 애플리케이션에 적합

**단점:**
- **CPU 리소스를 더 많이 사용**: 동시 수집으로 인한 오버헤드
- **메모리 단편화 문제 발생**: 압축 단계 부재

### 3. Garbage-First GC (G1 GC)

**특징:**
- **JDK 9 이상의 기본 GC**
- **힙을 균등한 크기의 영역(region)으로 나누어 관리**
- 가비지가 많은 영역부터 우선적으로 수집
- 일부 작업은 동시에, 일부는 STW로 처리

**장점:**
- **예측 가능한 일시 중지 시간**: `-XX:MaxGCPauseMillis` 옵션으로 목표 설정 가능
- **큰 힙에서도 효율적**: 메모리가 많은 환경에서 탁월한 성능
- **메모리 압축을 통한 단편화 방지**: 메모리 효율성 향상

**단점:**
- **추가 메모리 오버헤드**: 영역 관리를 위한 메타데이터
- **매우 작은 힙에서는 비효율적**: 오버헤드가 상대적으로 큼

**설정 예시:**
```bash
# G1 GC 활성화 및 목표 일시 중지 시간 설정
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
```

## GC 선택 가이드라인

### 1. 애플리케이션 특성에 따른 선택

| 애플리케이션 유형 | 권장 GC | 이유 |
|---|---|---|
| **배치 처리** | Parallel GC | 높은 처리량이 중요, 일시 중지 시간은 덜 중요 |
| **웹 애플리케이션** | G1 GC | 예측 가능한 응답 시간 필요 |
| **실시간 서비스** | G1 GC 또는 ZGC | 매우 짧은 일시 중지 시간 요구 |
| **마이크로서비스** | G1 GC | 다양한 메모리 사용 패턴에 적응적 |

### 2. 힙 크기에 따른 선택

- **< 100MB**: Serial GC 또는 Parallel GC
- **100MB ~ 4GB**: Parallel GC 또는 G1 GC
- **4GB+**: G1 GC 또는 ZGC

### 3. JDK 버전에 따른 기본값

- **JDK 8**: Parallel GC
- **JDK 9+**: G1 GC

## 실무 JVM 튜닝 체크리스트

### 1. 메모리 설정

```bash
# 힙 메모리 설정 (권장: 물리 메모리의 70-80%)
-Xms4g -Xmx4g  # 또는
-XX:InitialRAMPercentage=70.0 -XX:MaxRAMPercentage=70.0

# 메타스페이스 설정 (클래스 메타데이터)
-XX:MaxMetaspaceSize=256m

# Direct Memory 설정 (필요시)
-XX:MaxDirectMemorySize=1g
```

### 2. GC 설정

```bash
# G1 GC 설정 예시
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:G1HeapRegionSize=16m

# Parallel GC 설정 예시
-XX:+UseParallelGC
-XX:ParallelGCThreads=4
```

### 3. 디버깅 및 모니터링

```bash
# 힙 덤프 생성
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/app/heapdumps/

# GC 로깅 (JDK 11+)
-Xlog:gc*:gc.log:time,tags

# JFR (Java Flight Recorder)
-XX:+FlightRecorder
-XX:StartFlightRecording=duration=60s,filename=app.jfr
```

### 4. 성능 최적화

```bash
# 문자열 중복 제거 (G1 GC)
-XX:+UseStringDeduplication

# 큰 페이지 사용 (메모리 액세스 성능 향상)
-XX:+UseLargePages

# 컴파일러 최적화
-XX:+UseCompressedOops
-XX:+UseCompressedClassPointers
```

## 모니터링 및 분석 도구

### 1. GC 로그 분석
```bash
# GC 로그 형태 (G1 GC 예시)
[2025-09-07T10:30:15.123+0000][gc] GC(123) Pause Young (Normal) 45M->32M(512M) 12.456ms
```

### 2. 권장 도구
- **GCViewer**: GC 로그 시각화
- **VisualVM**: JVM 모니터링 및 프로파일링
- **JProfiler**: 상용 프로파일러
- **Grafana + Micrometer**: 실시간 모니터링

### 3. 주요 메트릭
- **Throughput**: 전체 시간 대비 애플리케이션 실행 시간
- **Latency**: GC 일시 중지 시간
- **Footprint**: 메모리 사용량

## 실무 팁과 주의사항

### 1. 컨테이너 환경에서의 주의점
```bash
# 컨테이너 메모리 인식을 위한 설정
-XX:+UseContainerSupport  # JDK 10+에서 기본값

# 비율 기반 메모리 설정 권장
-XX:MaxRAMPercentage=70.0
```

### 2. 성능 테스트 시 고려사항
- **워밍업**: JIT 컴파일러가 최적화할 시간 제공
- **안정화**: 충분한 시간 동안 부하를 유지
- **다양한 시나리오**: 다른 메모리 사용 패턴으로 테스트

### 3. 프로덕션 배포 전 체크
- [ ] 메모리 누수 테스트
- [ ] 장시간 부하 테스트
- [ ] GC 로그 분석
- [ ] OOM 시나리오 테스트

## 결론

JVM 튜닝과 GC 선택은 애플리케이션의 **특성**, **환경**, **요구사항**을 종합적으로 고려해야 하는 작업입니다.

### 핵심 포인트

1. **애플리케이션 특성 파악**: 처리량 vs 응답성
2. **환경 고려**: 컨테이너, 물리 서버, 클라우드
3. **지속적인 모니터링**: 실제 운영 데이터 기반 조정
4. **단계적 최적화**: 기본 설정부터 점진적 개선

현대적인 Java 애플리케이션에서는 **G1 GC**가 가장 균형잡힌 선택이며, 컨테이너 환경에서는 **비율 기반 메모리 설정**을 권장합니다. 

무엇보다 중요한 것은 **실제 운영 환경에서의 측정과 분석**을 통해 지속적으로 개선해나가는 것입니다.