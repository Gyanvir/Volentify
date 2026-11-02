package org.volentify.mesh.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import org.volentify.mesh.ui.theme.Palette

@Composable
fun SettingsScreen(vm: MeshViewModel, onClose: () -> Unit) {
    var server by remember { mutableStateOf(vm.settings.serverUrl) }
    var token by remember { mutableStateOf(vm.settings.gatewayToken.orEmpty()) }
    var mask by remember { mutableStateOf(vm.settings.maskLocation) }
    var name by remember { mutableStateOf(vm.settings.displayName) }
    val colors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = Palette.Signal, unfocusedBorderColor = Palette.Line, focusedTextColor = Palette.Ivory,
        unfocusedTextColor = Palette.Ivory, cursorColor = Palette.Signal, focusedLabelColor = Palette.Signal,
        unfocusedLabelColor = Palette.Stone,
    )

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Settings", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = onClose) { Text("Done", color = Palette.Sand) }
        }

        Text("Your name on messages", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(name, { name = it.take(40) }, label = { Text("Name or team") }, singleLine = true, colors = colors, modifier = Modifier.fillMaxWidth())

        Text("Gateway sync", style = MaterialTheme.typography.titleMedium)
        Text(
            "Whenever this phone gets mobile data or Wi-Fi it uploads every report it holds to the Volentify website automatically. A gateway token (from your web dashboard) is optional: it marks uploads as coming from a verified responder.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(server, { server = it }, label = { Text("Server address") }, singleLine = true, colors = colors, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(token, { token = it }, label = { Text("Gateway token (optional)") }, colors = colors, modifier = Modifier.fillMaxWidth(), maxLines = 3)
        Button(
            onClick = {
                vm.settings.serverUrl = server
                vm.settings.gatewayToken = token
                vm.settings.maskLocation = mask
                vm.settings.displayName = name
                vm.syncNow()
                onClose()
            },
            shape = RoundedCornerShape(50),
            colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Save and sync") }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Mask my exact location", style = MaterialTheme.typography.titleMedium)
                Text("Shifts reported positions by up to 500 m", style = MaterialTheme.typography.bodySmall)
            }
            Switch(mask, { mask = it }, colors = SwitchDefaults.colors(checkedTrackColor = Palette.Signal, checkedThumbColor = Palette.Ink))
        }

        Text("This phone", style = MaterialTheme.typography.titleMedium)
        Text("Mesh node ID — a random identifier, not your hardware address", style = MaterialTheme.typography.bodySmall)
        Text(vm.settings.nodeId, fontFamily = FontFamily.Monospace, color = Palette.Sand)
    }
}
