// POSIX interval timers are unavailable in Emscripten. Dispatch one-shot
// notifications on a dedicated thread, as required by MySQL's timer API.
#include "my_timer.h"

#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <system_error>
#include <thread>
#include <unordered_map>

namespace {
using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;

std::mutex mutex;
std::condition_variable changed;
std::unordered_map<my_timer_t *, Deadline> pending;
std::thread worker;
bool stopping = false;

void dispatch() {
  std::unique_lock<std::mutex> lock(mutex);
  while (!stopping) {
    auto next = pending.end();
    for (auto it = pending.begin(); it != pending.end(); ++it) {
      if (next == pending.end() || it->second < next->second) next = it;
    }
    if (next == pending.end()) {
      changed.wait(lock);
      continue;
    }

    const Deadline deadline = next->second;
    if (deadline > Clock::now()) {
      changed.wait_until(lock, deadline);
      continue;
    }

    auto *timer = next->first;
    pending.erase(next);
    lock.unlock();
    // The callback can delete this timer. Never access it after notification.
    timer->notify_function(timer);
    lock.lock();
  }
}
}  // namespace

int my_timer_initialize() {
  std::lock_guard<std::mutex> lock(mutex);
  if (worker.joinable()) return 0;
  stopping = false;
  try {
    worker = std::thread(dispatch);
  } catch (const std::system_error &error) {
    errno = error.code().value();
    return -1;
  }
  return 0;
}

void my_timer_deinitialize() {
  {
    std::lock_guard<std::mutex> lock(mutex);
    stopping = true;
    pending.clear();
  }
  changed.notify_one();
  if (worker.joinable()) worker.join();
}

int my_timer_create(my_timer_t *timer) {
  timer->id = 0;
  return 0;
}

int my_timer_set(my_timer_t *timer, unsigned long time) {
  std::lock_guard<std::mutex> lock(mutex);
  const auto now = Clock::now();
  const auto max_delay = std::chrono::duration_cast<std::chrono::milliseconds>(
      Deadline::max() - now);
  if (time > static_cast<unsigned long>(max_delay.count())) {
    errno = EOVERFLOW;
    return -1;
  }
  if (!time) {
    pending.erase(timer);
  } else {
    try {
      pending.insert_or_assign(timer, now + std::chrono::milliseconds(time));
    } catch (const std::bad_alloc &) {
      errno = ENOMEM;
      return -1;
    }
  }
  changed.notify_one();
  return 0;
}

int my_timer_cancel(my_timer_t *timer, int *state) {
  std::lock_guard<std::mutex> lock(mutex);
  *state = pending.erase(timer) != 0;
  changed.notify_one();
  return 0;
}

void my_timer_delete(my_timer_t *timer) {
  int state;
  my_timer_cancel(timer, &state);
}
