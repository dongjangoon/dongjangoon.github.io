# CLAUDE.md - Tech Blog: K8s, Monitoring & AI

This is a Jekyll-based GitHub Pages blog focused on **Kubernetes**, **monitoring/observability**, and **AI/ML** in cloud-native environments.

## 📖 Blog Overview

**Live URL**: https://dongjangoon.github.io  
**Repository**: https://github.com/dongjangoon/dongjangoon.github.io

This technical blog covers advanced topics in:
- **Kubernetes Operations**: Monitoring, logging, tracing, operators, CRDs
- **Observability Stack**: Prometheus, Grafana, Loki, Tempo, OpenTelemetry
- **Cloud-Native Security**: Istio service mesh, zero-trust architecture
- **AI/ML Operations**: MLOps, vLLM, RAG architectures, GenAI on AWS
- **Infrastructure**: Storage (RAID), private registries (Harbor), Helm templates

## 🏗️ Technical Architecture

### Platform
- **Framework**: Jekyll 4.x with GitHub Pages
- **Theme**: Minima with extensive customizations
- **Language**: Ruby with Bundler dependency management
- **CI/CD**: Automatic deployment via GitHub Actions on push to `main`

### Content Structure
```
├── _posts/          # 18 blog posts (2,900+ lines of technical content)
├── _layouts/        # Custom layout overrides (default.html)
├── _includes/       # Reusable components (head.html)
├── _config.yml      # Jekyll configuration
├── assets/          # Static assets (CSS, images)
├── categories.html  # Category browsing page
├── archive.html     # Date-based archive
└── about.markdown   # About page
```

### Key Features
- **Responsive Design**: Custom grid layout with sidebar navigation
- **Content Organization**: Category-based browsing, tag cloud, archive by year
- **SEO Optimized**: jekyll-seo-tag, sitemap, structured data
- **Syntax Highlighting**: Rouge with GFM support
- **Pagination**: 5 posts per page
- **Social Integration**: GitHub profile linking

## 🛠️ Development Workflow

### Local Development
```bash
# Setup
git clone https://github.com/dongjangoon/dongjangoon.github.io.git
cd dongjangoon.github.io
bundle install

# Development server
bundle exec jekyll serve
# ↳ http://localhost:4000

# Build for production
bundle exec jekyll build
```

### Content Creation
New posts follow the naming convention: `YYYY-MM-DD-title-with-hyphens.md`

**Writing Style Guidelines**:
- 문장 끝에 콜론(`:`)을 사용하지 않음. 콜론 대신 마침표로 문장을 끝내거나 문장을 자연스럽게 마무리할 것
- Bold 표시(`**텍스트**`) 뒤에 한글 조사가 올 경우 띄어쓰기 추가 (예: `**SMT** 를`, `**Unit** 이라는`)
- **모든 글은 front matter 바로 아래, 본문(`## 들어가며`) 시작 전에 AI 작성 고지 블록을 넣을 것.** minimal-mistakes notice 형식으로 작성한다:
  ```markdown
  **🤖 이 글은 AI를 활용하여 작성되었습니다.**
  {: .notice--info}
  ```

**Required front matter**:
```yaml
---
layout: post
title: "Your Post Title"
date: 2025-MM-DD HH:MM:SS +0000
categories: [kubernetes, monitoring, ai]
tags: [prometheus, grafana, opentelemetry]
excerpt: "Brief description for SEO and listings"
---
```

### Jekyll Configuration
Key `_config.yml` settings:
- **Permalink structure**: `/:categories/:year/:month/:day/:title/`
- **Plugins**: feed, sitemap, seo-tag, paginate, gist, github-metadata
- **Markdown**: Kramdown with GFM input
- **Highlighter**: Rouge for syntax highlighting

## 📚 Content Categories & Expertise

### Kubernetes & Container Orchestration
- **Monitoring Stack**: Complete guide to Prometheus, Grafana, Loki, Tempo integration
- **Custom Resources**: CRD patterns, Kubernetes Operators development
- **Security**: Pod security contexts, ServiceAccounts, in-cluster configurations
- **Storage**: RAID configurations for persistent volumes
- **Networking**: Istio service mesh, zero-trust architectures
- **Registry Management**: Harbor private registry setup and configuration

### Observability & Monitoring
- **Metrics**: Prometheus ServiceMonitor/PodMonitor CRDs, metric structures
- **Distributed Tracing**: Tempo configuration, troubleshooting database query tracing
- **Logging**: Kubernetes logging architectures, structured logging patterns
- **High Availability**: Prometheus clustering with Thanos
- **Application Monitoring**: Spring Boot Actuator integration with Prometheus

### AI/ML Operations
- **MLOps Pipelines**: Machine learning model deployment and lifecycle management
- **GenAI Infrastructure**: RAG (Retrieval Augmented Generation) on AWS
- **Vector Databases**: Implementation patterns for AI/ML workloads
- **Cloud Integration**: AWS AI/ML services integration strategies

### Development Practices
- **Reactive Programming**: Async patterns and reactive streams
- **Helm Templates**: Standardized Kubernetes application packaging
- **DevOps Integration**: CI/CD pipelines for containerized applications

## 🔧 Technical Commands

### Blog Management
```bash
# Create new post
touch _posts/$(date +%Y-%m-%d)-your-title.md

# Local preview
bundle exec jekyll serve --drafts --livereload

# Check build
bundle exec jekyll build --verbose

# Update dependencies
bundle update
```

### Git Workflow
```bash
# Add new content
git add _posts/your-new-post.md
git commit -m "feat: add post about kubernetes monitoring"
git push origin main
# ↳ Automatically deploys to GitHub Pages
```

## 🎯 Content Strategy

### Target Audience
- **DevOps Engineers** implementing Kubernetes monitoring solutions
- **SREs** building observability platforms
- **ML Engineers** deploying models in cloud-native environments
- **Platform Engineers** designing scalable infrastructure

### Content Depth
- **Deep Technical Guides**: 300-700 line comprehensive tutorials
- **Practical Examples**: Real-world implementation patterns
- **Troubleshooting**: Common issues and resolution strategies
- **Architecture Patterns**: Best practices for production deployments

### Topics Covered
1. **Infrastructure as Code**: Kubernetes operators, Helm charts
2. **Monitoring at Scale**: Prometheus federation, Grafana dashboards
3. **Security Best Practices**: Zero-trust networking, RBAC configurations
4. **ML Infrastructure**: Model serving, pipeline orchestration
5. **Performance Optimization**: Resource management, autoscaling

This blog serves as a comprehensive resource for practitioners implementing modern cloud-native infrastructure with a focus on observability, security, and AI/ML integration.