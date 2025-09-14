---
layout: single
title: "AWS Innovate AI/ML (AWS에서 GenAI RAG를 구성하기 위한 다양한 Vector database에 대해 알아보기)"
date: 2025-02-07 07:32:00 +0000
categories: ai
tags: [tech, ai, machine-learning]
excerpt: "대화, 스토리, 이미지, 동영상, 음악 등 새로운 콘텐츠와 아이디어를 생성하는, 대규모 데이터를 기반으로 사전 학습된 초거대 모델로, 일반적으로 파운데이션 모델 (FM)이라고 합니다."
notion_id: 193eef64-a1ca-808e-8463-c903e16d1348
notion_url: https://www.notion.so/AWS-Innovate-AI-ML-AWS-GenAI-RAG-Vector-database-193eef64a1ca808e8463c903e16d1348
---

# 생성형 AI (GenAI)란?

대화, 스토리, 이미지, 동영상, 음악 등 새로운 콘텐츠와 아이디어를 생성하는, 대규모 데이터를 기반으로 사전 학습된 초거대 모델로, 일반적으로 파운데이션 모델 (FM)이라고 합니다.


<!--more-->
## 전통적 기계학습 모델과 파운데이션 모델 비교

- 파운데이션 모델(Foundation Model): 대규모 데이터로 사전학습된 AI 모델로, 다양한 downstream 태스크에 적용될 수 있는 기반 모델
# 생성형 AI 활용 서비스 개발 시 도전 과제

- 학습 데이터에 의존적
- 기한이 지난 정보
- 부정확한 사실을 제공하는 환각 현상
- 맥락(컨텍스트) 이해 및 추론의 부족
## 파운데이션 모델의 도메인 적응 방법

1. 컨텍스트 기반 프롬프트 엔지니어링
1. 검색 증강 생성 (RAG) 활용
1. 사전 훈련된 파운데이션 모델 파인 튜닝
1. 자체적인 파운데이션 모델 훈련
## 파운데이션 모델에 도메인 적응 비용과 효과성

# 검색 증강 생성 (RAG, Retrieval-Augmented Generation)

1. 최신/특정 도메인 지식 베이스 생성 (배치성 작업)
1. 사용자 질문 제출 (실시간)
1. **질문 임베딩을 지식 베이스에 질의 → (지식베이스가) 유사한 문서 검색하여 컨텍스트로 변환 → RAG**
1. **질문 + 변환된 컨텍스트** → 컨텍스트 기반 프롬프트로 확장
1. 생성 AI 활용 서비스는 신뢰성 높은 정보 생성
→ 즉, RAG이란 사용자 질문을 지식 베이스에 검색하여 프롬프트를 증강하여 파운데이션 모델이 생성하는 답변의 정보와 신뢰성을 증강하도록 하는 것

→ 따라서 지식 베이스를 좋은 퀄리티로 구축하는 것이 중요함

# RAG의 지식 베이스 구축 프로세스

1. 원시 데이터 (이미지, 문서, 오디오)
1. 데이터 추출, 청크 단위로 분할해 **인코더**를 활용한 벡터 임베딩 생성
1. 데이터 적재 단계
1. 데이터 활용
# 벡터 데이터 베이스

> 실시간 벡터 임베딩을 저장, 변경, 관리 및 고성능 벡터 유사성 검색 알고리즘을 제공하는 벡터 저장소

- 수백~수천 차원의 벡터 데이터를 효율적으로 저장
- 텍스트, 이미지, 오디오 등 다양한 데이터 타입의 임베딩 처리
- 벡터와 함께 원본 데이터, 태그, 타임스탬프와 같은 메타데이터도 저장
- 필터링과 조건 검색 지원
- 예: Finecone, Weaviate, Chroma, ElasticSearch, PostgreSQL, Mongodb
([https://www.mongodb.com/ko-kr/resources/basics/databases/vector-databases](https://www.mongodb.com/ko-kr/resources/basics/databases/vector-databases))

## 벡터 (Vector)

- 크기와 방향을 함께 갖는 양
- N차원의 원소들의 배열, 1xN 행렬, 행 벡터
- (0.275, 0.827, -0.133, …, -0.394)
## 임베딩 (Embedding)

- 임베딩은 단어, 문장, 문서, 이미지 등의 데이터를 모델의 인코더를 활용하여 컴퓨터가 이해할 수 있는 형태의 벡터로 변환하는 과정 또는 변환된 벡터
- 예: 대량의 고양이 사진 컬렉션 (비정형 데이터)
## 벡터 공간 (Vector space)

## 벡터 간의 유사성 측정

예) 고양이 관련 이미지의 벡터가 주어졌을 때, 강아지 관련 이미지의 벡터와의 유사도를 측정할 수 있음

## 벡터 검색 알고리즘

- k-NN k-최근접 이웃 (k-Nearest Neighbors)
- A-NN 근사 최근접 이웃 (Approximate Nearest Neighbors)
## 벡터 데이터베이스 동작 과정

1. **인덱싱**
1. **쿼리**: 인덱스 벡터를 쿼리 벡터와 비교하여 최근접 벡터를 결정함. 여기서 유사성 측정 방법들이 존재함.
1. **후처리**: 다른 유사성 척도, 메타데이터 기반으로 쿼리의 최근접 항목을 다시 매기고 필터링
## 대규모 벡터 검색을 위한 ANN 기반 인덱싱 알고리즘

- FLAT - 인덱스가 없는 경우와 같이 데이터셋의 모든 벡터를 처음부터 끝까지 순서대로 검토하여 유사한 벡터를 찾는 소요 시간이 오래 걸리는 방식 - Full Scan Serach 와 유사
### IVFFlat (Inverted File with Flat Compression)

- K-means 기반 버킷 구성 (클러스터 = 버킷, 각 버킷에 속하는 벡터를 리스트로 색인하는 방식)
- 빠른 인덱싱
- List, Probes 매개변수
### HNSW (Hierarchical navigable small world)

- 그래프 기반, 이웃 벡터 레이어구성
- 대규모 데이터 세트의 고성능, 높은 재현율
- M, ef_construction, ef_search 매개변수
# 레퍼런스

[https://kr-resources.awscloud.com/aws-ai-and-machinelearning-innovate](https://kr-resources.awscloud.com/aws-ai-and-machinelearning-innovate)

[https://www.elastic.co/kr/what-is/vector-database](https://www.elastic.co/kr/what-is/vector-database)

[https://www.mongodb.com/ko-kr/resources/basics/databases/vector-databases](https://www.mongodb.com/ko-kr/resources/basics/databases/vector-databases)

[https://aws.amazon.com/ko/what-is/foundation-models/](https://aws.amazon.com/ko/what-is/foundation-models/)


---

*Originally published in [Notion](https://www.notion.so/AWS-Innovate-AI-ML-AWS-GenAI-RAG-Vector-database-193eef64a1ca808e8463c903e16d1348) on February 07, 2025*