<div align="center">

# 🎞️ Figugiffy

### Upload Once. Explore. Select. Create.

A local-first web application for extracting multiple moments from long-form videos and turning them into individual GIFs.

<br />

![Status](https://img.shields.io/badge/Status-In%20Development-orange?style=for-the-badge)
![React](https://img.shields.io/badge/React-TypeScript-61DAFB?style=for-the-badge&logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Git](https://img.shields.io/badge/Git-Version%20Control-F05032?style=for-the-badge&logo=git&logoColor=white)

<br />

**One video → Multiple moments → Multiple GIFs**

</div>

---

## Overview

Figugiffy is a browser-based video-to-GIF workspace designed around a simple problem:

> **What if I want to create several GIFs from different moments of the same long video?**

Instead of repeatedly uploading the same video to a converter, Figugiffy is designed around a **single-upload, multi-selection workflow**.

The user loads a video once, explores its timeline, identifies interesting moments, creates multiple selections, and eventually generates separate GIFs from those selections.

The project is being developed with a **local-first approach**, with the goal of keeping media processing as close to the user's device as practical.

---

## The Core Workflow

```text
┌──────────────────────┐
│     Upload Video     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Explore Timeline   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Select Many Moments │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│    Generate GIFs     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Export GIF Files   │
└──────────────────────┘
