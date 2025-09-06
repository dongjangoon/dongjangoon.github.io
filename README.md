# Tech Blog - K8s, Monitoring & AI

A Jekyll-based GitHub Pages blog focused on Kubernetes, monitoring, observability, and AI/ML in cloud-native environments.

## 🚀 Quick Start

### Prerequisites
- Ruby 2.7+ with Bundler
- Git

### Local Development

1. **Clone and setup:**
   ```bash
   git clone https://github.com/dongjangoon/dongjangoon.github.io.git
   cd dongjangoon.github.io
   ```

2. **Install dependencies:**
   ```bash
   bundle install
   ```

3. **Run locally:**
   ```bash
   bundle exec jekyll serve
   ```

4. **Visit your blog:**
   Open `http://localhost:4000` in your browser

### Creating New Posts

1. **Create a new file** in `_posts/` directory with format:
   ```
   YYYY-MM-DD-title-with-hyphens.md
   ```

2. **Add front matter** at the top:
   ```yaml
   ---
   layout: post
   title: "Your Post Title"
   date: 2025-01-01 10:00:00 +0900
   categories: [kubernetes, monitoring, ai]
   tags: [prometheus, grafana, opentelemetry]
   ---
   ```

3. **Write your content** in Markdown below the front matter

### Deployment

The blog automatically deploys to `https://dongjangoon.github.io` when you push to the main branch:

```bash
git add .
git commit -m "Add new post: your-post-title"
git push origin main
```

## 📝 Blog Configuration

- **Theme**: Minima
- **Plugins**: SEO, pagination, syntax highlighting, feed generation
- **Posts per page**: 5
- **Permalink format**: `/:categories/:year/:month/:day/:title/`

## 🛠️ Customization

- Edit `_config.yml` for site-wide settings
- Modify layouts in `_layouts/` directory
- Add custom CSS in `assets/css/`
- Update author info and social links in `_config.yml`

## 📚 Current Topics

This blog covers:
- Kubernetes operations and best practices
- Monitoring with Prometheus, Grafana, Loki, Tempo
- OpenTelemetry and observability patterns
- AI/ML integration with cloud-native infrastructure
- MLOps and service mesh architectures

## 🔗 Links

- **Live Blog**: https://dongjangoon.github.io
- **GitHub Repository**: https://github.com/dongjangoon/dongjangoon.github.io