// Local Node pipe transport for the MySQL command service.
#include <emscripten.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>
#include "my_rapidjson_size_t.h"
#include "my_time.h"
#include "mysql/com_data.h"
#include "mysql/service_command.h"
#include "mysql/service_srv_session.h"
#include "mysql/service_srv_session_info.h"
#include "mysql_com.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"
#include "sql/sql_class.h"
#include "sql_string.h"

EM_JS(bool, mysql_wasm_node, (), { return typeof process === 'object' && !!process.versions?.node; });

namespace {
std::mutex mailbox_mutex;
std::condition_variable mailbox_changed;
std::string mailbox;
bool mailbox_closed = false;

int read_mailbox(char *buffer, size_t capacity) {
  std::unique_lock lock(mailbox_mutex);
  mailbox_changed.wait(lock, [] { return mailbox_closed || !mailbox.empty(); });
  const size_t size = std::min(capacity, mailbox.size());
  memcpy(buffer, mailbox.data(), size);
  mailbox.erase(0, size);
  return size;
}
}  // namespace

extern "C" EMSCRIPTEN_KEEPALIVE void mysql_wasm_submit(const char *frame) {
  std::lock_guard lock(mailbox_mutex);
  mailbox += frame;
  mailbox_changed.notify_one();
}

extern "C" EMSCRIPTEN_KEEPALIVE void mysql_wasm_finish() {
  std::lock_guard lock(mailbox_mutex);
  mailbox_closed = true;
  mailbox_changed.notify_one();
}

EM_JS(int, mysql_wasm_read, (char *buffer, int length), {
  // Read on the server pthread, keeping the JS main thread free for FS proxying.
  try {
    return require('node:fs').readSync(0, HEAPU8, Number(buffer), length, null);
  } catch (error) {
    return error.code === 'EAGAIN' || error.code === 'EINTR' ? -2 : -1;
  }
});

namespace {
using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

void emit(const rapidjson::StringBuffer &json) {
  std::fputs("MYSQL_WASM\t", stdout);
  std::fwrite(json.GetString(), 1, json.GetSize(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void string(Writer &out, std::string_view value) {
  out.String(value.empty() ? "" : value.data(), value.size());
}

std::string hex(std::string_view value) {
  static constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(value.size() * 2);
  for (unsigned char byte : value) {
    result.push_back(digits[byte >> 4]);
    result.push_back(digits[byte & 15]);
  }
  return result;
}

unsigned from_digit(char digit) {
  if (digit >= '0' && digit <= '9') return digit - '0';
  if (digit >= 'a' && digit <= 'f') return digit - 'a' + 10;
  throw std::invalid_argument("invalid hexadecimal data");
}

std::string unhex(std::string_view value) {
  if (value.size() % 2) throw std::invalid_argument("invalid hexadecimal size");
  std::string result(value.size() / 2, '\0');
  for (size_t i = 0; i < result.size(); ++i) {
    result[i] = (from_digit(value[i * 2]) << 4) | from_digit(value[i * 2 + 1]);
  }
  return result;
}

struct Field {
  std::string name;
  uint type, charset, flags;
};
using Row = std::vector<std::optional<std::string>>;
struct Result {
  std::vector<Field> fields;
  std::vector<Row> rows;
  ulonglong affected = 0;
};
struct Command {
  bool multi = false;
  bool preparing = false;
  std::vector<Result> results;
  Result result;
  Row row;
  uint errno_value = 0;
  std::string error;
  std::string sqlstate;
};

Command &context(void *ptr) { return *static_cast<Command *>(ptr); }

const st_command_service_cbs callbacks{
    .start_result_metadata = [](void *, uint, uint, const CHARSET_INFO *) { return 0; },
    .field_metadata = [](void *ptr, st_send_field *field, const CHARSET_INFO *) {
      context(ptr).result.fields.push_back(
          {field->col_name, uint(field->type), field->charsetnr, field->flags});
      return 0;
    },
    .end_result_metadata = nullptr,
    .start_row = [](void *ptr) { context(ptr).row.clear(); return 0; },
    .end_row = [](void *ptr) {
      auto &cmd = context(ptr);
      cmd.result.rows.push_back(std::move(cmd.row));
      return 0;
    },
    .abort_row = [](void *ptr) { context(ptr).row.clear(); },
    .get_client_capabilities = [](void *ptr) -> ulong {
      return CLIENT_MULTI_RESULTS | CLIENT_PS_MULTI_RESULTS |
             (context(ptr).multi ? CLIENT_MULTI_STATEMENTS : 0);
    },
    .get_null = [](void *ptr) { context(ptr).row.emplace_back(); return 0; },
    .get_integer = [](void *ptr, longlong value) {
      context(ptr).row.emplace_back(std::to_string(value)); return 0;
    },
    .get_longlong = [](void *ptr, longlong value, uint is_unsigned) {
      context(ptr).row.emplace_back(is_unsigned ? std::to_string(ulonglong(value))
                                                : std::to_string(value));
      return 0;
    },
    .get_decimal = [](void *ptr, const decimal_t *value) {
      char buffer[128];
      int length = sizeof(buffer);
      if (decimal2string(value, buffer, &length)) return 1;
      context(ptr).row.emplace_back(std::in_place, buffer, length);
      return 0;
    },
    .get_double = [](void *ptr, double value, uint32) {
      char buffer[32];
      const int length = std::snprintf(buffer, sizeof(buffer), "%.17g", value);
      context(ptr).row.emplace_back(std::in_place, buffer, length);
      return 0;
    },
    .get_date = [](void *ptr, const MYSQL_TIME *value) {
      char buffer[64];
      const int length = my_date_to_str(*value, buffer);
      context(ptr).row.emplace_back(std::in_place, buffer, length);
      return 0;
    },
    .get_time = [](void *ptr, const MYSQL_TIME *value, uint decimals) {
      char buffer[64];
      const int length = my_time_to_str(*value, buffer, decimals);
      context(ptr).row.emplace_back(std::in_place, buffer, length);
      return 0;
    },
    .get_datetime = [](void *ptr, const MYSQL_TIME *value, uint decimals) {
      char buffer[64];
      const int length = my_datetime_to_str(*value, buffer, decimals);
      context(ptr).row.emplace_back(std::in_place, buffer, length);
      return 0;
    },
    .get_string = [](void *ptr, const char *value, size_t length, const CHARSET_INFO *charset) {
      auto &row = context(ptr).row;
      if (!charset || charset == &my_charset_bin || charset == &my_charset_utf8mb4_bin) {
        row.emplace_back(std::in_place, value, length);
      } else {
        String utf8;
        uint errors = 0;
        if (utf8.copy(value, length, charset, &my_charset_utf8mb4_bin, &errors)) return 1;
        row.emplace_back(std::in_place, utf8.ptr(), utf8.length());
      }
      return 0;
    },
    .handle_ok = [](void *ptr, uint, uint, ulonglong affected, ulonglong, const char *) {
      auto &cmd = context(ptr);
      if (!cmd.preparing) {
        cmd.result.affected = affected;
        cmd.results.push_back(std::move(cmd.result));
        cmd.result = {};
      }
    },
    .handle_error = [](void *ptr, uint code, const char *error, const char *state) {
      auto &cmd = context(ptr);
      cmd.errno_value = code;
      cmd.error = error;
      cmd.sqlstate = state;
    },
    .shutdown = nullptr,
    .connection_alive = nullptr,
};

void run(MYSQL_SESSION session, enum_server_command type, const COM_DATA &data,
         Command &cmd) {
  if (command_service_run_command(session, type, &data, &my_charset_utf8mb4_bin,
                                  &callbacks, CS_TEXT_REPRESENTATION, &cmd) &&
      cmd.error.empty()) {
    cmd.error = "MySQL command service failed";
  }
}

Command execute(MYSQL_SESSION session, char mode, const std::string &sql,
                const std::vector<std::string_view> &args) {
  Command cmd;
  COM_DATA data{};
  if (mode != 'p') {
    cmd.multi = mode == 'e';
    data.com_query.query = sql.data();
    data.com_query.length = sql.size();
    run(session, COM_QUERY, data, cmd);
    return cmd;
  }

  std::vector<std::string> values;
  std::vector<PS_PARAM> parameters;
  values.reserve(args.size());
  parameters.reserve(args.size());
  for (auto arg : args) {
    if (arg.empty()) throw std::invalid_argument("invalid SQL parameter");
    auto &value = values.emplace_back(unhex(arg.substr(1)));
    PS_PARAM param{};
    param.value = reinterpret_cast<const unsigned char *>(value.data());
    param.length = value.size();
    switch (arg.front()) {
      case 'n': param.type = MYSQL_TYPE_NULL; param.null_bit = 1; break;
      case 's': param.type = MYSQL_TYPE_STRING; break;
      case 'b': param.type = MYSQL_TYPE_BLOB; break;
      case 'd': param.type = MYSQL_TYPE_DOUBLE; break;
      case 'u': param.unsigned_type = 1; [[fallthrough]];
      case 'i': param.type = MYSQL_TYPE_LONGLONG; break;
      default: throw std::invalid_argument("invalid SQL parameter type");
    }
    if ((param.type == MYSQL_TYPE_DOUBLE || param.type == MYSQL_TYPE_LONGLONG) &&
        param.length != 8) throw std::invalid_argument("invalid numeric SQL parameter");
    parameters.push_back(param);
  }
  cmd.preparing = true;
  data.com_stmt_prepare.query = sql.data();
  data.com_stmt_prepare.length = sql.size();
  run(session, COM_STMT_PREPARE, data, cmd);
  if (!cmd.error.empty()) return cmd;
  if (cmd.result.rows.empty() || cmd.result.rows.front().size() < 3) {
    throw std::runtime_error("missing prepared statement metadata");
  }
  const auto &metadata = cmd.result.rows.front();
  const auto id = std::stoul(metadata[0].value());
  const auto count = std::stoul(metadata[2].value());
  cmd = {};
  if (count != parameters.size()) {
    cmd.error = "SQL parameter count does not match placeholders";
  } else {
    data = {};
    data.com_stmt_execute.stmt_id = id;
    data.com_stmt_execute.parameters = parameters.data();
    data.com_stmt_execute.parameter_count = parameters.size();
    data.com_stmt_execute.has_new_types = 1;
    run(session, COM_STMT_EXECUTE, data, cmd);
  }
  Command ignored;
  data = {};
  data.com_stmt_close.stmt_id = id;
  run(session, COM_STMT_CLOSE, data, ignored);
  return cmd;
}

void respond(const Command &cmd) {
  rapidjson::StringBuffer buffer;
  Writer out(buffer);
  out.StartObject();
  if (!cmd.error.empty()) {
    out.Key("error"); string(out, cmd.error);
    out.Key("errno"); out.Uint(cmd.errno_value);
    out.Key("sqlstate"); string(out, cmd.sqlstate);
  } else {
    out.Key("results"); out.StartArray();
    for (const auto &result : cmd.results) {
      out.StartObject();
      out.Key("affectedRows"); out.Uint64(result.affected);
      out.Key("fields"); out.StartArray();
      for (const auto &field : result.fields) {
        out.StartObject();
        out.Key("name"); string(out, field.name);
        out.Key("type"); out.Uint(field.type);
        out.Key("charset"); out.Uint(field.charset);
        out.Key("flags"); out.Uint(field.flags);
        out.EndObject();
      }
      out.EndArray();
      out.Key("rows"); out.StartArray();
      for (const auto &row : result.rows) {
        out.StartArray();
        for (const auto &value : row) {
          if (value) string(out, hex(*value));
          else out.Null();
        }
        out.EndArray();
      }
      out.EndArray();
      out.EndObject();
    }
    out.EndArray();
  }
  out.EndObject();
  emit(buffer);
}

void handle(MYSQL_SESSION session, std::string_view line) {
  try {
    if (line.size() < 2 || line[1] != '\t' ||
        (line[0] != 'q' && line[0] != 'e' && line[0] != 'p')) {
      throw std::invalid_argument("invalid SQL command");
    }
    const char mode = line[0];
    line.remove_prefix(2);
    auto end = line.find('\t');
    auto sql = unhex(line.substr(0, end));
    std::vector<std::string_view> args;
    while (end != std::string_view::npos) {
      line.remove_prefix(end + 1);
      end = line.find('\t');
      args.push_back(line.substr(0, end));
    }
    respond(execute(session, mode, sql, args));
  } catch (const std::exception &error) {
    Command cmd;
    cmd.error = error.what();
    respond(cmd);
  }
}
}  // namespace

bool mysql_wasm_run_session() {
  MYSQL_SESSION session = srv_session_open(nullptr, nullptr);
  if (!session) return false;
  srv_session_info_get_thd(session)->security_context()->skip_grants("root");

  rapidjson::StringBuffer ready;
  Writer writer(ready);
  writer.StartObject(); writer.Key("ready"); writer.Bool(true); writer.EndObject();
  emit(ready);

  std::string pending;
  char chunk[4096];
  int count;
  // The in-process Node runtime submits requests like the browser does.
  auto read = mysql_wasm_node() && !getenv("MYSQL_WASM_MAILBOX") ? mysql_wasm_read : +[](char *buffer, int size) { return read_mailbox(buffer, size); };
  while ((count = read(chunk, sizeof(chunk))) != 0) {
    if (count == -2) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      continue;
    }
    if (count < 0) break;
    size_t scan = pending.size();
    pending.append(chunk, count);
    size_t start = 0;
    size_t end;
    while ((end = pending.find('\n', scan)) != std::string::npos) {
      handle(session, std::string_view(pending).substr(start, end - start));
      scan = start = end + 1;
    }
    pending.erase(0, start);
  }
  if (count == 0 && !pending.empty()) handle(session, pending);
  return srv_session_close(session) == 0 && count == 0;
}
