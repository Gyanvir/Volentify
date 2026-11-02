package org.volentify.mesh.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.volentify.mesh.data.DeliveryStatus
import org.volentify.mesh.data.Envelope
import org.volentify.mesh.data.MeshDatabase
import org.volentify.mesh.data.Settings
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Gateway outbox sync (FR-08, AT-06…AT-08). Any phone with internet uploads everything it holds —
 * its own reports and those relayed to it — in batches of up to 100. Records are only marked
 * server-confirmed after a 200 acknowledgement; network or 5xx failures retry with exponential backoff.
 *
 * Two paths share one uploader: an immediate upload whenever the phone has validated internet (new report,
 * report relayed in, network comes back), and WorkManager as the durable backup that survives process death.
 * WorkManager alone was slow: a job sitting in exponential backoff ignores new requests (KEEP), so a report
 * relayed in could wait minutes before upload.
 */
object GatewaySync {
    private const val ONE_SHOT = "gateway-sync-now"
    private const val PERIODIC = "gateway-sync-periodic"
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val active = AtomicBoolean(false)
    private val rerun = AtomicBoolean(false)

    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<GatewaySyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** Uploads right away when the phone is online, and queues the WorkManager backup either way. */
    fun requestSoon(context: Context) {
        val app = context.applicationContext
        uploadNow(app)
        val request = OneTimeWorkRequestBuilder<GatewaySyncWorker>()
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(app).enqueueUniqueWork(ONE_SHOT, ExistingWorkPolicy.KEEP, request)
    }

    /** Immediate path. Requests that arrive while an upload runs are coalesced into one more pass. */
    fun uploadNow(context: Context) {
        val app = context.applicationContext
        if (!isOnline(app)) return
        rerun.set(true)
        if (!active.compareAndSet(false, true)) return
        scope.launch {
            try {
                while (rerun.getAndSet(false)) {
                    if (!isOnline(app)) break
                    if (GatewayUploader.run(app) != GatewayUploader.Outcome.DONE) {
                        rerun.set(false) // server or network trouble: the WorkManager job retries with backoff
                        break
                    }
                }
            } catch (_: Exception) {
                // Never crash the process from a background upload; WorkManager remains the backup.
            } finally {
                active.set(false)
            }
            if (rerun.get()) uploadNow(app)
        }
    }

    /** True when the default network has validated internet access. */
    fun isOnline(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return false) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}

/** The single upload loop, used by the immediate path and by the WorkManager job. */
object GatewayUploader {
    enum class Outcome { DONE, RETRY }

    private val lock = Mutex()
    private val http by lazy {
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    }
    private val json = "application/json".toMediaType()

    suspend fun run(context: Context): Outcome = lock.withLock { withContext(Dispatchers.IO) { upload(context) } }

    private suspend fun upload(context: Context): Outcome {
        val settings = Settings(context)
        val dao = MeshDatabase.get(context).dao()
        dao.purgeConfirmedBefore(System.currentTimeMillis() - TimeUnit.HOURS.toMillis(72))
        refreshIncidents(settings)

        // A gateway token is optional: without one, reports still upload as public field reports the moment the
        // phone has any internet (mobile data or Wi-Fi), so they reach the website as disaster data.
        var token = settings.gatewayToken
        var batchSize = 100
        while (true) {
            val batch = dao.outbox(batchSize)
            if (batch.isEmpty()) break
            val ids = batch.map { it.eventId }
            dao.setStatus(ids, DeliveryStatus.SYNCING)
            val body = JSONObject().apply {
                put("gateway_node_id", settings.nodeId)
                batteryPercent(context)?.let { put("gateway_battery", it) }
                put("events", JSONArray().apply { batch.forEach { put(Envelope.toJson(it)) } })
            }
            try {
                val request = Request.Builder()
                    .url("${settings.serverUrl}/api/mesh/ingest")
                    .apply { token?.let { header("Authorization", "Bearer $it") } }
                    .post(body.toString().toRequestBody(json))
                    .build()
                http.newCall(request).execute().use { resp ->
                    val text = resp.body?.string().orEmpty()
                    when {
                        resp.isSuccessful -> {
                            val ack = try { JSONObject(text) } catch (_: JSONException) { JSONObject() }
                            dao.confirm(ids, ack.optString("gateway_ack_id", "ack"), System.currentTimeMillis())
                            settings.lastSyncAt = System.currentTimeMillis()
                            settings.lastSyncMessage = "Uploaded ${ack.optInt("accepted_count")} new, " +
                                "${ack.optInt("duplicate_count")} already on the server" +
                                (if (token == null) " as public field reports" else "") +
                                if (ack.optString("persistence") == "volatile") " (server has no database connected — not stored yet)" else ""
                        }
                        resp.code == 401 && token != null -> {
                            // Expired gateway token: forget it and keep uploading as public field reports.
                            dao.setStatus(ids, DeliveryStatus.QUEUED)
                            settings.gatewayToken = null
                            token = null
                        }
                        resp.code == 429 -> {
                            dao.setStatus(ids, DeliveryStatus.QUEUED)
                            settings.lastSyncMessage = "Server is busy; retrying shortly"
                            return Outcome.RETRY
                        }
                        resp.code == 422 && ids.size > 1 -> {
                            // Isolate the invalid report by retrying one at a time.
                            dao.setStatus(ids, DeliveryStatus.QUEUED)
                            batchSize = 1
                        }
                        resp.code == 422 -> {
                            dao.fail(ids, text.take(200))
                            settings.lastSyncMessage = "Server rejected a report as invalid"
                        }
                        else -> {
                            dao.setStatus(ids, DeliveryStatus.QUEUED)
                            settings.lastSyncMessage = "Server unavailable (${resp.code}); retrying"
                            return Outcome.RETRY
                        }
                    }
                }
            } catch (e: IOException) {
                dao.resetSyncing()
                settings.lastSyncMessage = "No connection to the server; will retry"
                return Outcome.RETRY
            } catch (e: IllegalArgumentException) {
                // Malformed server address in Settings: nothing will succeed until it is fixed.
                dao.resetSyncing()
                settings.lastSyncMessage = "Check the server address in Settings"
                return Outcome.DONE
            }
        }
        return Outcome.DONE
    }

    @Volatile private var incidentsFetchedAt = 0L

    /** Cached incident list for offline report linking; refreshed at most every five minutes. */
    private fun refreshIncidents(settings: Settings) {
        val now = System.currentTimeMillis()
        if (now - incidentsFetchedAt < 5 * 60_000L) return
        incidentsFetchedAt = now
        try {
            val request = Request.Builder().url("${settings.serverUrl}/api/mesh/incidents").build()
            http.newCall(request).execute().use { resp ->
                if (resp.isSuccessful) settings.incidentsJson = resp.body?.string()
            }
        } catch (_: IOException) {
        } catch (_: IllegalArgumentException) {
        }
    }

    private fun batteryPercent(context: Context): Int? {
        val bm = context.getSystemService(BatteryManager::class.java) ?: return null
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
    }
}

class GatewaySyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = when (GatewayUploader.run(applicationContext)) {
        GatewayUploader.Outcome.DONE -> Result.success()
        GatewayUploader.Outcome.RETRY -> Result.retry()
    }
}
