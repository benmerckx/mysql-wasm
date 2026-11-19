#include "my_timer.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <thread>

using namespace std::chrono_literals;

namespace {
std::atomic<unsigned> fired{0};
void notify(my_timer_t *) { ++fired; }
void notify_and_delete(my_timer_t *timer) {
  my_timer_delete(timer);
  ++fired;
}
}  // namespace

int main() {
  if (my_timer_initialize()) return 1;
  my_timer_t timer{};
  my_timer_t cancelled{};
  if (my_timer_create(&timer) || my_timer_create(&cancelled)) std::abort();
  timer.notify_function = notify_and_delete;
  cancelled.notify_function = notify;
  if (my_timer_set(&cancelled, 30000) || my_timer_set(&timer, 100)) std::abort();
  int state = 0;
  if (my_timer_cancel(&cancelled, &state) || state != 1) std::abort();
  auto deadline = std::chrono::steady_clock::now() + 5s;
  while (!fired && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(5ms);
  }
  if (my_timer_cancel(&timer, &state) || state != 0) std::abort();
  if (my_timer_set(&cancelled, 30000)) std::abort();
  my_timer_deinitialize();
  if (fired != 1) return 1;

  if (my_timer_initialize() || my_timer_set(&cancelled, 10)) std::abort();
  deadline = std::chrono::steady_clock::now() + 5s;
  while (fired == 1 && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(5ms);
  }
  my_timer_deinitialize();
  return fired == 2 ? 0 : 1;
}
