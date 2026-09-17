# 🚀 Teleport Chess

A dynamic, multi-player chess variant played in real-time over the network, developed and implemented end-to-end using an **AI-Driven Development** approach. The project features complex game logic, responsive UI, and user experience (UI/UX) optimizations based on playtesting feedback.

---

## 🌟 Key Features

* **Dynamic Portal Mechanics:** Special portal squares that allow pieces to teleport to designated target squares.
* **Real-Time Multiplayer:** Full synchronization between two players in separate game rooms via WebSockets.
* **Accessible User Experience (UI/UX):**
  * **Portal Move Cancellation:** Ability to exit and cancel portal selection mode by clicking anywhere on the dimmed background.
  * **Last Move Highlight:** Clear visual feedback for the opponent's move that remains visible even on top of portal squares.
  * **King Check Indicator:** Automatic visual highlighting when a King is under attack.
  * **Captured Pieces Display:** Real-time tracking and rendering of captured pieces inside player info panels.
* **Responsive Layout:** Dynamic CSS calculations ensuring an optimal layout on both mobile devices and desktop screens without overflow.

---

## 🛠️ Tech Stack & Architecture

* **Backend:** Node.js, Express, Socket.io (Room management, real-time events, turn enforcement).
* **Frontend:** Vanilla JavaScript, HTML5, CSS3 (CSS Grid, CSS Variables, Flexbox).
* **Game Engine:** Dedicated logic module for calculating legal moves, check conditions, and portal validation.

---

## 💻 Local Setup & Installation

1. **Clone the Repository:**
   ```bash
   git clone [https://github.com/your-username/teleport-chess.git](https://github.com/your-username/teleport-chess.git)
   cd teleport-chess
