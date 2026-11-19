// Replaces libssl. The server runs without networking or TLS, but its TLS
// setup and reporting code still links against these functions. Contexts
// cannot be created, which MySQL treats as TLS being unavailable, so no SSL
// object or session ever exists for the remaining calls. Including the real
// header keeps every signature exact, which Wasm requires for calls to link.
#include <openssl/pem.h>
#include <openssl/ssl.h>

int OPENSSL_init_ssl(uint64_t opts, const OPENSSL_INIT_SETTINGS *settings) { return 1; }
const SSL_METHOD *TLS_client_method(void) { return NULL; }
const SSL_METHOD *TLS_server_method(void) { return NULL; }

SSL_CTX *SSL_CTX_new(const SSL_METHOD *method) { return NULL; }
void SSL_CTX_free(SSL_CTX *ctx) {}
int SSL_CTX_check_private_key(const SSL_CTX *ctx) { return 0; }
long SSL_CTX_ctrl(SSL_CTX *ctx, int cmd, long larg, void *parg) { return 0; }
X509_VERIFY_PARAM *SSL_CTX_get0_param(SSL_CTX *ctx) { return NULL; }
X509_STORE *SSL_CTX_get_cert_store(const SSL_CTX *ctx) { return NULL; }
int SSL_CTX_get_security_level(const SSL_CTX *ctx) { return 0; }
long SSL_CTX_get_timeout(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_get_verify_depth(const SSL_CTX *ctx) { return 0; }
int SSL_CTX_get_verify_mode(const SSL_CTX *ctx) { return SSL_VERIFY_NONE; }
int SSL_CTX_load_verify_locations(SSL_CTX *ctx, const char *file, const char *path) { return 0; }
int SSL_CTX_set0_tmp_dh_pkey(SSL_CTX *ctx, EVP_PKEY *key) { return 0; }
int SSL_CTX_set_cipher_list(SSL_CTX *ctx, const char *list) { return 0; }
int SSL_CTX_set_ciphersuites(SSL_CTX *ctx, const char *list) { return 0; }
int SSL_CTX_set_default_verify_paths(SSL_CTX *ctx) { return 0; }
int SSL_CTX_set_num_tickets(SSL_CTX *ctx, size_t count) { return 0; }
uint64_t SSL_CTX_set_options(SSL_CTX *ctx, uint64_t options) { return 0; }
int SSL_CTX_set_session_id_context(SSL_CTX *ctx, const unsigned char *id, unsigned int length) { return 0; }
long SSL_CTX_set_timeout(SSL_CTX *ctx, long timeout) { return 0; }
void SSL_CTX_set_verify(SSL_CTX *ctx, int mode, SSL_verify_cb callback) {}
int SSL_CTX_use_PrivateKey_file(SSL_CTX *ctx, const char *file, int type) { return 0; }
int SSL_CTX_use_certificate_chain_file(SSL_CTX *ctx, const char *file) { return 0; }

SSL *SSL_new(SSL_CTX *ctx) { return NULL; }
void SSL_free(SSL *ssl) {}
int SSL_accept(SSL *ssl) { return -1; }
int SSL_connect(SSL *ssl) { return -1; }
int SSL_clear(SSL *ssl) { return 0; }
long SSL_ctrl(SSL *ssl, int cmd, long larg, void *parg) { return 0; }
int SSL_get_error(const SSL *ssl, int result) { return SSL_ERROR_SSL; }
int SSL_get_fd(const SSL *ssl) { return -1; }
int SSL_pending(const SSL *ssl) { return 0; }
int SSL_read(SSL *ssl, void *buffer, int length) { return -1; }
int SSL_write(SSL *ssl, const void *buffer, int length) { return -1; }
int SSL_shutdown(SSL *ssl) { return -1; }
int SSL_set_fd(SSL *ssl, int fd) { return 0; }
uint64_t SSL_set_options(SSL *ssl, uint64_t options) { return 0; }
void SSL_set_quiet_shutdown(SSL *ssl, int mode) {}
int SSL_set_session(SSL *ssl, SSL_SESSION *session) { return 0; }
SSL_SESSION *SSL_get_session(const SSL *ssl) { return NULL; }
X509 *SSL_get_certificate(const SSL *ssl) { return NULL; }
X509 *SSL_get1_peer_certificate(const SSL *ssl) { return NULL; }
const char *SSL_get_cipher_list(const SSL *ssl, int n) { return NULL; }
const SSL_CIPHER *SSL_get_current_cipher(const SSL *ssl) { return NULL; }
const char *SSL_CIPHER_get_name(const SSL_CIPHER *cipher) { return "(NONE)"; }
long SSL_get_default_timeout(const SSL *ssl) { return 0; }
const char *SSL_get_servername(const SSL *ssl, const int type) { return NULL; }
int SSL_get_verify_depth(const SSL *ssl) { return 0; }
int SSL_get_verify_mode(const SSL *ssl) { return SSL_VERIFY_NONE; }
long SSL_get_verify_result(const SSL *ssl) { return X509_V_OK; }
const char *SSL_get_version(const SSL *ssl) { return ""; }
int SSL_session_reused(const SSL *ssl) { return 0; }

SSL_SESSION *PEM_read_bio_SSL_SESSION(BIO *bio, SSL_SESSION **session, pem_password_cb *callback, void *data) { return NULL; }
void SSL_SESSION_free(SSL_SESSION *session) {}
int SSL_SESSION_is_resumable(const SSL_SESSION *session) { return 0; }
long SSL_SESSION_set_timeout(SSL_SESSION *session, long timeout) { return 0; }
