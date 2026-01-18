# Minimal Mistakes 이미지 기능 가이드

## 📁 디렉토리 구조
```
assets/images/
├── posts/      # 포스트 본문 이미지
├── headers/    # 헤더/대표 이미지
└── gallery/    # 갤러리 이미지
```

## 🎨 Minimal Mistakes 이미지 기능

### 1️⃣ Header Image (포스트 상단 대표 이미지)

포스트 front matter에 추가:
```yaml
---
layout: single
title: "Kubernetes 모니터링 구축"
header:
  image: /assets/images/headers/k8s-monitoring-wide.png
  teaser: /assets/images/headers/k8s-monitoring-thumb.png
  caption: "Photo credit: [**Unsplash**](https://unsplash.com)"
---
```

**권장 이미지 크기**:
- `image`: 1280x600px (헤더 이미지)
- `teaser`: 500x300px (썸네일)

### 2️⃣ Figure (캡션 있는 이미지)

```liquid
{% raw %}{% include figure image_path="/assets/images/posts/prometheus-architecture.png"
   alt="Prometheus Architecture"
   caption="그림 1: Prometheus 전체 아키텍처" %}{% endraw %}
```

**이미지 정렬 옵션**:
```liquid
{% raw %}# 좌측 정렬
{% include figure image_path="/assets/images/posts/example.png"
   alt="설명" caption="캡션" class="align-left" %}

# 우측 정렬
{% include figure image_path="/assets/images/posts/example.png"
   alt="설명" caption="캡션" class="align-right" %}

# 중앙 정렬
{% include figure image_path="/assets/images/posts/example.png"
   alt="설명" caption="캡션" class="align-center" %}{% endraw %}
```

### 3️⃣ Gallery (이미지 갤러리)

포스트 front matter에 갤러리 정의:
```yaml
---
layout: single
title: "Grafana 대시보드 구축"
gallery:
  - url: /assets/images/gallery/dashboard-1.png
    image_path: /assets/images/gallery/dashboard-1-thumb.png
    alt: "클러스터 개요"
    title: "Kubernetes 클러스터 개요 대시보드"
  - url: /assets/images/gallery/dashboard-2.png
    image_path: /assets/images/gallery/dashboard-2-thumb.png
    alt: "Pod 메트릭"
    title: "Pod별 리소스 사용량"
  - url: /assets/images/gallery/dashboard-3.png
    image_path: /assets/images/gallery/dashboard-3-thumb.png
    alt: "네트워크 메트릭"
    title: "네트워크 트래픽 모니터링"
---
```

포스트 본문에서 갤러리 표시:
```liquid
{% raw %}{% include gallery caption="Grafana 대시보드 예제" %}{% endraw %}
```

**여러 갤러리 사용**:
```yaml
---
gallery1:
  - url: /assets/images/gallery/monitoring-1.png
    image_path: /assets/images/gallery/monitoring-1.png
gallery2:
  - url: /assets/images/gallery/logging-1.png
    image_path: /assets/images/gallery/logging-1.png
---
```

```liquid
{% raw %}{% include gallery id="gallery1" caption="모니터링 대시보드" %}
{% include gallery id="gallery2" caption="로깅 대시보드" %}{% endraw %}
```

**갤러리 레이아웃**:
```liquid
{% raw %}# 2열 그리드
{% include gallery id="gallery1" layout="half" %}

# 3열 그리드 (기본값)
{% include gallery id="gallery1" %}{% endraw %}
```

### 4️⃣ 기본 Markdown 이미지

간단한 이미지 삽입:
```markdown
![Prometheus Logo](/assets/images/posts/prometheus-logo.png)
```

## 📝 실전 예제

### 예제 1: Header Image + Figure 조합
```yaml
---
layout: single
title: "Prometheus Operator를 이용한 Kubernetes 모니터링"
categories: [kubernetes, monitoring]
header:
  image: /assets/images/headers/prometheus-operator-header.png
  teaser: /assets/images/headers/prometheus-operator-thumb.png
---

Prometheus Operator를 사용하면 Kubernetes 클러스터 모니터링을 쉽게 구성할 수 있습니다.

{% raw %}{% include figure image_path="/assets/images/posts/prometheus-operator-architecture.png"
   alt="Prometheus Operator Architecture"
   caption="그림 1: Prometheus Operator 아키텍처" %}{% endraw %}

## ServiceMonitor 설정

{% raw %}{% include figure image_path="/assets/images/posts/servicemonitor-example.png"
   alt="ServiceMonitor YAML"
   caption="그림 2: ServiceMonitor 리소스 예제"
   class="align-center" %}{% endraw %}
```

### 예제 2: 갤러리 활용
```yaml
---
layout: single
title: "Grafana 대시보드 모음"
categories: [monitoring, grafana]
gallery_cluster:
  - url: /assets/images/gallery/cluster-overview.png
    image_path: /assets/images/gallery/cluster-overview.png
    alt: "클러스터 개요"
  - url: /assets/images/gallery/node-metrics.png
    image_path: /assets/images/gallery/node-metrics.png
    alt: "노드 메트릭"
  - url: /assets/images/gallery/pod-metrics.png
    image_path: /assets/images/gallery/pod-metrics.png
    alt: "Pod 메트릭"
---

# Kubernetes 클러스터 대시보드

다음은 클러스터 모니터링에 사용하는 Grafana 대시보드입니다.

{% raw %}{% include gallery id="gallery_cluster" caption="Kubernetes 클러스터 모니터링 대시보드" %}{% endraw %}
```

### 예제 3: 이미지 정렬 활용
```markdown
{% raw %}{% include figure image_path="/assets/images/posts/architecture-diagram.png"
   alt="시스템 아키텍처"
   caption="시스템 전체 구성도"
   class="align-right" %}{% endraw %}

오른쪽 이미지는 전체 시스템 아키텍처를 보여줍니다.
Prometheus가 중앙에서 메트릭을 수집하고,
Grafana가 시각화를 담당합니다.

이 구성은 다음과 같은 장점이 있습니다:
- 확장성이 뛰어남
- 관리가 용이함
- 고가용성 지원
```

## 💡 이미지 최적화 팁

### 파일 크기 최적화
```bash
# ImageMagick 사용 (설치: sudo apt install imagemagick)
convert input.png -quality 85 -resize 1200x output.jpg

# 헤더 이미지 생성
convert input.png -resize 1280x600^ -gravity center -extent 1280x600 header.png

# 썸네일 생성
convert input.png -resize 500x300^ -gravity center -extent 500x300 thumb.png
```

### 파일명 규칙
- 소문자 + 하이픈 사용: `prometheus-architecture.png`
- 날짜 접두사 (선택): `2025-01-prometheus-setup.png`
- 설명적인 이름 사용: `good-name.png` vs `img1.png`

## 🚀 빠른 시작

1. **이미지 준비**
   ```bash
   # 헤더 이미지: 1280x600px
   # 썸네일: 500x300px
   # 본문 이미지: 최대 1200px 폭
   ```

2. **이미지 저장**
   ```bash
   cp my-header.png assets/images/headers/
   cp my-post-image.png assets/images/posts/
   ```

3. **포스트에 추가**
   ```yaml
   ---
   header:
     image: /assets/images/headers/my-header.png
   ---

   {% raw %}{% include figure image_path="/assets/images/posts/my-post-image.png"
      alt="설명" caption="캡션" %}{% endraw %}
   ```

4. **로컬 테스트**
   ```bash
   bundle exec jekyll serve
   ```

## 📚 참고 자료

- [Minimal Mistakes - Images](https://mmistakes.github.io/minimal-mistakes/docs/helpers/#gallery)
- [Minimal Mistakes - Header Images](https://mmistakes.github.io/minimal-mistakes/docs/layouts/#header-overlay)
- [Jekyll - Liquid Includes](https://jekyllrb.com/docs/includes/)
